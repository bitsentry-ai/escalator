import type { Pool } from "pg";
import {
  ruleHistoryQuerySchema,
  ruleHistorySnapshotSchema,
  type RuleHistoryQuery,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  type RuleHistoryRepository,
} from "@bitsentry-escalator/features/application";
import { investigationTransaction } from "./investigation-transaction.js";
import { ruleHistorySql } from "./rule-history-sql.js";
export class PostgresRuleHistoryRepository implements RuleHistoryRepository {
  constructor(private readonly pool: Pool) {}
  snapshot(scope: WorkspaceId, raw: RuleHistoryQuery) {
    const query = ruleHistoryQuerySchema.parse(raw);
    // Existing bounded transaction also fences pool acquisition and scope setup.
    return investigationTransaction(this.pool, scope, async (db) => {
      const result = await db.query(ruleHistorySql(query.kind), [
        scope,
        query.streamId,
        query.serviceId,
        query.environmentId,
        query.startAt,
        query.endAt,
        query.visibleAt,
      ]);
      if (!result.rows[0]) throw new PersistenceError("not_found");
      return ruleHistorySnapshotSchema.parse(result.rows[0].snapshot);
    });
  }
}
