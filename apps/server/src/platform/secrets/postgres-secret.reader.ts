import type { Pool } from "pg";
import {
  SecretAccessError,
  type SecretUse,
  type PersistedSecretClaim,
} from "@bitsentry-escalator/features/application";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import type { SecretEnvelope } from "./keyring.js";
import type { EncryptedSecretReader } from "./encrypted-secret.store.js";

export class PostgresSecretReader implements EncryptedSecretReader {
  constructor(private readonly pool: Pool) {}
  async load(request: SecretUse) {
    const relation =
      request.queue === "job"
        ? "escalator_job"
        : request.queue === "outbox"
          ? "escalator_outbox"
          : undefined;
    if (!relation) throw new SecretAccessError();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        request.workspaceId,
      ]);
      const result = await client.query<{
        id: string;
        workspace_id: WorkspaceId;
        envelope: SecretEnvelope;
        disabled_at: Date | null;
        work_id: string;
        state: string;
        lease_token: string | null;
        lease_expires_at: Date | null;
        database_now: Date;
        approved_secret_ids: unknown;
      }>(
        `SELECT s.id, s.workspace_id, s.envelope, s.disabled_at, w.id AS work_id,
        w.state, w.lease_token, w.lease_expires_at, clock_timestamp() AS database_now,
        w.payload->'secretIds' AS approved_secret_ids
        FROM escalator_secret AS s JOIN ${relation} AS w ON w.workspace_id=s.workspace_id AND w.id=$2
        WHERE s.workspace_id=$1 AND s.id=$3`,
        [request.workspaceId, request.workId, request.secretId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return undefined;
      const claim: PersistedSecretClaim = {
        workspaceId: row.workspace_id,
        workId: row.work_id,
        queue: request.queue,
        state: row.state,
        token: row.lease_token,
        expiresAt: row.lease_expires_at?.toISOString() ?? null,
        databaseNow: row.database_now.toISOString(),
        approvedSecretIds: row.approved_secret_ids,
      };
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        envelope: row.envelope,
        disabled: row.disabled_at !== null,
        claim,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
