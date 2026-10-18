import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  configurationTransaction,
  pagingTransaction,
  type ConfigurationRepository,
  type ConfigurationTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { postgresConfigurationStore } from "./postgres-configuration.store.js";
export class PostgresConfigurationRepository implements ConfigurationRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: ConfigurationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, (base, connection, guard) =>
      work(
        configurationTransaction(
          pagingTransaction(
            base,
            postgresPagingStore(connection, scope),
            guard,
          ),
          postgresConfigurationStore(connection, scope),
          guard,
        ),
      ),
    );
  }
}
