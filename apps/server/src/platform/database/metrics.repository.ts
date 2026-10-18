import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  signalTransaction,
  metricsTransaction,
  type MetricsRepository,
  type MetricsTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresMetricsStore } from "./postgres-metrics.store.js";
export class PostgresMetricsRepository implements MetricsRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: MetricsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        return work(
          metricsTransaction(
            signalTransaction(
              base,
              postgresSignalStore(connection, scope),
              guard,
            ),
            postgresMetricsStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
