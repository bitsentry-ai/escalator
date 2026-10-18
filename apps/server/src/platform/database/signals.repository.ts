import type { Pool } from "pg";
import {
  signalTokenSchema,
  workspaceIdSchema,
  opaqueIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  signalTransaction,
  type SignalRepository,
  type SignalTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";

export class PostgresSignalRepository implements SignalRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(private readonly pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: SignalTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        return work(
          signalTransaction(
            base,
            postgresSignalStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
  async findTokenContext(hash: string) {
    signalTokenSchema.shape.tokenHash.parse(hash);
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      await connection.query(
        "SELECT set_config('app.workspace_id', '', true), set_config('app.signal_token_hash', $1, true)",
        [hash],
      );
      const result = await connection.query<{
        workspace_id: string;
        source_id: string;
        id: string;
      }>(
        "SELECT workspace_id,source_id,id FROM escalator_signal_token WHERE token_hash=$1",
        [hash],
      );
      const row = result.rows[0];
      const context = row
        ? {
            workspaceId: workspaceIdSchema.parse(row.workspace_id),
            sourceId: opaqueIdSchema.parse(row.source_id),
            id: opaqueIdSchema.parse(row.id),
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
