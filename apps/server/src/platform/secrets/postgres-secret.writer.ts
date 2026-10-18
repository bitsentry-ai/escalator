import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  hasCapability,
  configurationPageSchema,
  type ConfigurationPageInput,
  type Actor,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import { SecretAccessError } from "@bitsentry-escalator/features/application";
import { SecretKeyRing, type SecretEnvelope } from "./keyring.js";

/** Local maintenance process only; never constructed from an HTTP request body. */
export class SecretRotationOperator {
  constructor(readonly workspaceId: WorkspaceId) {}
}
type SecretPrincipal = Actor | SecretRotationOperator;
/** Host authentication constructs Actor; plaintext never enters audit metadata. */
export class PostgresSecretWriter {
  constructor(
    private readonly pool: Pool,
    private readonly keys: SecretKeyRing,
  ) {}
  private async transaction<T>(
    actor: SecretPrincipal,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (
      !(actor instanceof SecretRotationOperator) &&
      !hasCapability(actor.role, "secret:manage")
    )
      throw new SecretAccessError();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        actor.workspaceId,
      ]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async audit(
    client: PoolClient,
    actor: SecretPrincipal,
    id: string,
    action: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO escalator_audit
      (workspace_id,id,actor,action,subject_type,subject_id,recorded_at,metadata)
      VALUES ($1,$2,$3::jsonb,$4,'secret',$5,transaction_timestamp(),'{}'::jsonb)`,
      [
        actor.workspaceId,
        randomUUID(),
        JSON.stringify(
          actor instanceof SecretRotationOperator
            ? { kind: "system", component: "secret-key-rotation" }
            : { kind: "responder", responderId: actor.responderId },
        ),
        action,
        id,
      ],
    );
  }
  async create(actor: Actor, name: string, value: Uint8Array) {
    if (!hasCapability(actor.role, "secret:manage"))
      throw new SecretAccessError();
    const label = name.trim();
    if (!label || label.length > 120)
      throw new Error("Secret name must contain 1–120 characters");
    const id = randomUUID();
    const owned = Buffer.from(value);
    try {
      const envelope = this.keys.seal(
        { workspaceId: actor.workspaceId, id },
        owned,
      );
      await this.transaction(actor, async (client) => {
        await client.query(
          "INSERT INTO escalator_secret (workspace_id,id,name,envelope) VALUES ($1,$2,$3,$4::jsonb)",
          [actor.workspaceId, id, label, JSON.stringify(envelope)],
        );
        await this.audit(client, actor, id, "secret.created");
      });
      return { workspaceId: actor.workspaceId, id, name: label };
    } finally {
      owned.fill(0);
    }
  }
  async list(actor: Actor, input: ConfigurationPageInput) {
    const { limit = 25, after } = configurationPageSchema.parse(input);
    return this.transaction(actor, async (client) => {
      const result = await client.query<{ id: string; name: string }>(
        `SELECT id,name FROM escalator_secret
         WHERE workspace_id=$1 AND purpose='provider' AND disabled_at IS NULL
           AND ($2::text IS NULL OR id>$2)
         ORDER BY id LIMIT $3`,
        [actor.workspaceId, after ?? null, limit + 1],
      );
      const items = result.rows.slice(0, limit);
      return {
        items,
        next: result.rows.length > limit ? items.at(-1)!.id : null,
      };
    });
  }
  async disable(actor: Actor, id: string): Promise<boolean> {
    return this.transaction(actor, async (client) => {
      const result = await client.query(
        `UPDATE escalator_secret SET disabled_at=clock_timestamp(),
        updated_at=clock_timestamp(), revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL RETURNING id`,
        [actor.workspaceId, id],
      );
      if (result.rowCount !== 1) return false;
      await this.audit(client, actor, id, "secret.disabled");
      return true;
    });
  }
  /** Repeat from the start until remaining=0; revision checks preserve concurrent edits. */
  async rotateBatch(
    actor: SecretPrincipal,
    after: string | undefined,
    limit = 50,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid rotation batch size");
    const rows = await this.transaction(
      actor,
      async (client) =>
        (
          await client.query<{
            id: string;
            revision: number;
            envelope: SecretEnvelope;
          }>(
            `SELECT id,revision,envelope FROM escalator_secret WHERE workspace_id=$1
      AND ($2::text IS NULL OR id>$2) AND envelope->>'keyId'<>$3 ORDER BY id LIMIT $4`,
            [actor.workspaceId, after ?? null, this.keys.activeKeyId, limit],
          )
        ).rows,
    );
    let rotated = 0;
    let conflicts = 0;
    for (const row of rows) {
      const identity = { workspaceId: actor.workspaceId, id: row.id };
      const value = this.keys.open(identity, row.envelope);
      let envelope: SecretEnvelope;
      try {
        envelope = this.keys.seal(identity, value);
      } finally {
        value.fill(0);
      }
      const updated = await this.transaction(actor, async (client) => {
        const result = await client.query(
          `UPDATE escalator_secret SET envelope=$4::jsonb,
          revision=revision+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id`,
          [actor.workspaceId, row.id, row.revision, JSON.stringify(envelope)],
        );
        if (result.rowCount !== 1) return false;
        await this.audit(client, actor, row.id, "secret.rotated");
        return true;
      });
      if (updated) rotated++;
      else conflicts++;
    }
    const remaining = await this.transaction(
      actor,
      async (client) =>
        (
          await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM escalator_secret WHERE workspace_id=$1 AND envelope->>'keyId'<>$2",
            [actor.workspaceId, this.keys.activeKeyId],
          )
        ).rows[0].count,
    );
    return {
      rotated,
      conflicts,
      remaining: Number(remaining),
      next: rows.at(-1)?.id,
    };
  }
}
