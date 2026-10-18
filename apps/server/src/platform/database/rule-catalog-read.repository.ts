import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  withRuleCatalogRead,
  type RuleCatalogReadRepository,
  type RuleCatalogReadTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
import { postgresRuleCatalogReadStore } from "./postgres-rule-catalog-read.store.js";
export class PostgresRuleCatalogReadRepository implements RuleCatalogReadRepository {
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleCatalogReadTransaction) => Promise<T>,
  ): Promise<T> {
    return withBoundedRulePool(this.pool, (bounded) =>
      new PostgresFoundationRepository(bounded).withConnection(
        scope,
        async (base, db, guard) => {
          await db.query("SET LOCAL statement_timeout = '5s'");
          await db.query("SET LOCAL lock_timeout = '1s'");
          return work(
            withRuleCatalogRead(
              base,
              postgresRuleCatalogReadStore(db, scope),
              guard,
            ),
          );
        },
      ),
    );
  }
}
