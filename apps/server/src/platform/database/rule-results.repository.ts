import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  withRuleResults,
  type RuleResultsRepository,
  type RuleResultsTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
import { postgresRuleResultsStore } from "./postgres-rule-results.store.js";
export class PostgresRuleResultsRepository implements RuleResultsRepository {
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleResultsTransaction) => Promise<T>,
  ): Promise<T> {
    return withBoundedRulePool(this.pool, (bounded) =>
      new PostgresFoundationRepository(bounded).withConnection(
        scope,
        async (base, db, guard) => {
          await db.query("SET LOCAL statement_timeout = '5s'");
          await db.query("SET LOCAL lock_timeout = '1s'");
          return work(
            withRuleResults(base, postgresRuleResultsStore(db, scope), guard),
          );
        },
      ),
    );
  }
}
