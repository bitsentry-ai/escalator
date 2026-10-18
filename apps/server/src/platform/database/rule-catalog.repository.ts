import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  withRuleCatalog,
  type RuleCatalogRepository,
  type RuleCatalogTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
import { postgresRulePolicyStore } from "./postgres-rule-policy.store.js";
import { postgresRuleCatalogStore } from "./postgres-rule-catalog.store.js";
import { postgresRuleReviewEvidence } from "./postgres-rule-review-evidence.js";
export class PostgresRuleCatalogRepository implements RuleCatalogRepository {
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleCatalogTransaction) => Promise<T>,
  ): Promise<T> {
    return withBoundedRulePool(this.pool, (bounded) =>
      new PostgresFoundationRepository(bounded).withConnection(
        scope,
        async (base, db, guard) => {
          await db.query("SET LOCAL statement_timeout = '5s'");
          await db.query("SET LOCAL lock_timeout = '1s'");
          const authorized = {
            ...base,
            responders: {
              ...base.responders,
              get: (id: Parameters<typeof base.responders.get>[0]) =>
                guard.operation(async () => {
                  const rows = await db.query(
                    "SELECT id FROM escalator_responder WHERE workspace_id=$1 AND id=$2 FOR SHARE",
                    [scope, id],
                  );
                  return rows.rowCount === 1
                    ? base.responders.get(id)
                    : undefined;
                }),
            },
          };
          const policy = postgresRulePolicyStore(db, scope, true);
          return work(
            withRuleCatalog(
              authorized,
              postgresRuleCatalogStore(db, scope, {
                lockDefinition: (version) => policy.lock({ version }),
                evidence: postgresRuleReviewEvidence(db, scope, authorized),
              }),
              guard,
            ),
          );
        },
      ),
    );
  }
}
