import type { Pool } from "pg";
import {
  heartbeatGrantSchema,
  workspaceIdSchema,
  opaqueIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  signalTransaction,
  heartbeatTransaction,
  type HeartbeatRepository,
  type HeartbeatTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresHeartbeatStore } from "./postgres-heartbeats.store.js";

export class PostgresHeartbeatRepository implements HeartbeatRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(private readonly pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: HeartbeatTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        return work(
          heartbeatTransaction(
            signalTransaction(
              base,
              postgresSignalStore(connection, scope),
              guard,
            ),
            postgresHeartbeatStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
  async findGrantContext(hash: string) {
    heartbeatGrantSchema.shape.tokenHash.parse(hash);
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      await connection.query(
        "SELECT set_config('app.workspace_id', '', true), set_config('app.heartbeat_token_hash', $1, true)",
        [hash],
      );
      const result = await connection.query<{
        workspace_id: string;
        probe_id: string;
      }>(
        "SELECT workspace_id,probe_id FROM escalator_heartbeat_grant WHERE token_hash=$1",
        [hash],
      );
      const row = result.rows[0];
      const context = row
        ? {
            workspaceId: workspaceIdSchema.parse(row.workspace_id),
            probeId: opaqueIdSchema.parse(row.probe_id),
          }
        : undefined;
      await connection.query("COMMIT");
      return context;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
