import {
  RuleProposalLeaseFence,
  withRuleProposals,
  withRuleReplay,
  withRuleReplayCapture,
  withRuleBacktests,
  type RuleProposalRepository,
  type RuleProposalTransaction,
} from "@bitsentry-escalator/features/application";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import type { Pool } from "pg";
import { postgresRuleProposalStore } from "./postgres-rule-proposal.store.js";
import { postgresRuleReplayStore } from "./postgres-rule-replay.store.js";
import { postgresRuleReplayCaptureStore } from "./postgres-rule-replay-capture.store.js";
import { postgresRuleBacktestStore } from "./postgres-rule-backtest.store.js";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { withBoundedRulePool } from "./bounded-rule-pool.js";
export class PostgresRuleProposalRepository implements RuleProposalRepository {
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleProposalTransaction) => Promise<T>,
  ): Promise<T> {
    const fence = new RuleProposalLeaseFence();
    return withBoundedRulePool(
      this.pool,
      (bounded) =>
        new PostgresFoundationRepository(bounded).withConnection(
          scope,
          async (base, db, guard) => {
            await db.query("SET LOCAL statement_timeout = '5s'");
            await db.query("SET LOCAL lock_timeout = '1s'");
            const proposal = postgresRuleProposalStore(
              db,
              scope,
              base.work,
              fence,
            );
            const tx = withRuleProposals(
              withRuleBacktests(
                withRuleReplayCapture(
                  withRuleReplay(
                    base,
                    postgresRuleReplayStore(db, scope),
                    guard,
                  ),
                  postgresRuleReplayCaptureStore(db, scope),
                  guard,
                ),
                postgresRuleBacktestStore(db, scope),
                guard,
              ),
              proposal.store,
              guard,
            );
            const result = await work(tx);
            await proposal.assertClaimLive();
            return result;
          },
        ),
      10000,
      () => performance.now(),
      () => fence.assertLive(),
    );
  }
}
