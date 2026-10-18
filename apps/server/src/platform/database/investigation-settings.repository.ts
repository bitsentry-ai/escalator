import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  investigationSettingsTransaction,
  type InvestigationSettingsRepository,
  type InvestigationSettingsTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresInvestigationSettingsStore } from "./postgres-investigation-settings.store.js";
export class PostgresInvestigationSettingsRepository implements InvestigationSettingsRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(
    pool: Pool,
    private readonly repositoryConnections = new RepositoryConnections(),
  ) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: InvestigationSettingsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      return work(
        investigationSettingsTransaction(
          base,
          postgresInvestigationSettingsStore(
            db,
            scope,
            this.repositoryConnections,
          ),
          guard,
        ),
      );
    });
  }
}
