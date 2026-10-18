import { postgresRuleReplayCaptureStore } from "./postgres-rule-replay-capture.store.js";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  withRuleReplay,
  withRuleReplayCapture,
  type RuleReplayRepository,
  type RuleReplayCaptureRepository,
  type RuleReplayCaptureTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresRuleReplayStore } from "./postgres-rule-replay.store.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
export class PostgresRuleReplayRepository
  implements RuleReplayRepository, RuleReplayCaptureRepository
{
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleReplayCaptureTransaction) => Promise<T>,
  ): Promise<T> {
    return withBoundedRulePool(this.pool, (bounded) =>
      new PostgresFoundationRepository(bounded).withConnection(
        scope,
        async (base, db, guard) => {
          await db.query("SET LOCAL statement_timeout = '5s'");
          await db.query("SET LOCAL lock_timeout = '1s'");
          return work(
            withRuleReplayCapture(
              withRuleReplay(base, postgresRuleReplayStore(db, scope), guard),
              postgresRuleReplayCaptureStore(db, scope),
              guard,
            ),
          );
        },
      ),
    );
  }
}
