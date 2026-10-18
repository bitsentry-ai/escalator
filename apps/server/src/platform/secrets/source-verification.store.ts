import type { Pool } from "pg";
import {
  SecretAccessError,
  assertSourceVerificationClaim,
  type SourceVerificationClaim,
  type SourceVerificationSecrets,
  type SourceVerificationUse,
} from "@bitsentry-escalator/features/application";
import { SecretKeyRing, type SecretEnvelope } from "./keyring.js";

/** Inbound verification uses persisted receiver authority, never a fabricated job claim. */
export class PostgresSourceVerificationSecrets implements SourceVerificationSecrets {
  constructor(
    private readonly pool: Pool,
    private readonly keys: SecretKeyRing,
  ) {}
  private async load(use: SourceVerificationUse): Promise<Buffer> {
    use.signal.throwIfAborted();
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      await connection.query("SET LOCAL lock_timeout = '1s'");
      await connection.query("SELECT set_config('app.workspace_id',$1,true)", [
        use.workspaceId,
      ]);
      const result = await connection.query<{
        source: Record<string, unknown>;
        grant: Record<string, unknown>;
        secret_id: string;
        workspace_id: string;
        envelope: SecretEnvelope;
        disabled_at: Date | null;
        service_enabled: boolean;
      }>(
        `SELECT s.data AS source,g.data AS grant,k.id AS secret_id,k.workspace_id,k.envelope,
         k.disabled_at,v.enabled AS service_enabled
         FROM escalator_signal_source s
         JOIN escalator_signal_token g ON g.workspace_id=s.workspace_id AND g.source_id=s.id
         JOIN escalator_secret k ON k.workspace_id=s.workspace_id AND k.id=s.auth_secret_id
         JOIN escalator_service v ON v.workspace_id=s.workspace_id AND v.id=s.service_id
         WHERE s.workspace_id=$1 AND s.id=$2 AND g.id=$3 AND g.token_hash=$4 AND k.id=$5 AND k.purpose='provider'
         FOR SHARE OF s,g,k,v`,
        [
          use.workspaceId,
          use.sourceId,
          use.grantId,
          use.receiverHash,
          use.secretId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new SecretAccessError();
      const clock = await connection.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      const claim: SourceVerificationClaim = {
        source: { ...row.source, workspaceId: row.workspace_id },
        grant: { ...row.grant, workspaceId: row.workspace_id },
        secret: {
          id: row.secret_id,
          workspaceId: row.workspace_id,
          enabled: row.disabled_at === null,
        },
        serviceEnabled: row.service_enabled,
        databaseNow: clock.rows[0].now.toISOString(),
      };
      assertSourceVerificationClaim(use, claim);
      // Release metadata locks before the caller's acceptance transaction.
      await connection.query("COMMIT");
      use.signal.throwIfAborted();
      return this.keys.open(
        { id: row.secret_id, workspaceId: row.workspace_id },
        row.envelope,
      );
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  async withSecret<T>(
    use: SourceVerificationUse,
    consume: (bytes: Uint8Array) => T,
  ): Promise<T> {
    let bytes: Buffer;
    try {
      bytes = await this.load(use);
    } catch {
      throw new SecretAccessError();
    }
    try {
      use.signal.throwIfAborted();
      // Preserve invalid-MAC/input errors for the shared HTTP response mapper.
      return consume(bytes);
    } finally {
      bytes.fill(0);
    }
  }
}
