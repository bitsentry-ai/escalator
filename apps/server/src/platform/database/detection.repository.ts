import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  configurationTransaction,
  detectionTransaction,
  pagingTransaction,
  signalTransaction,
  type DetectionRepository,
  type DetectionTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { postgresConfigurationStore } from "./postgres-configuration.store.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresDetectionStore } from "./postgres-detection.store.js";
export class PostgresDetectionRepository implements DetectionRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: DetectionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        const configuration = configurationTransaction(
          pagingTransaction(
            base,
            postgresPagingStore(connection, scope),
            guard,
          ),
          postgresConfigurationStore(connection, scope),
          guard,
        );
        const signals = signalTransaction(
          base,
          postgresSignalStore(connection, scope),
          guard,
        );
        return work(
          detectionTransaction(
            { ...configuration, ...signals },
            postgresDetectionStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
