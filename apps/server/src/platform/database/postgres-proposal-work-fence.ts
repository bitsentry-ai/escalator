import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  RuleProposalLeaseFence,
  PersistenceError,
  type WorkWriter,
  type WorkLease,
  type TransactionGuard,
} from "@bitsentry-escalator/features/application";
/** Evaluation uses the generic job runner, but publication still needs a live
 * job token checked at the proposal transaction's commit boundary. */
export function postgresProposalWorkFence(
  db: PoolClient,
  scope: WorkspaceId,
  work: WorkWriter,
  fence: RuleProposalLeaseFence,
  guard: TransactionGuard,
) {
  let claim: WorkLease | undefined;
  async function assertLive(): Promise<void> {
    fence.assertLive();
    if (!claim) return;
    const started = fence.start();
    const result = await db.query<{ remaining: number }>(
      `SELECT extract(epoch FROM (LEAST(lease_expires_at,$4::timestamptz)-clock_timestamp()))::double precision*1000 AS remaining
   FROM escalator_job WHERE workspace_id=$1 AND id=$2 AND state='running' AND kind='rules.proposal-evaluate' AND lease_token=$3 AND attempt_count=$5`,
      [scope, claim.id, claim.token, claim.leaseExpiresAt, claim.attempt],
    );
    if (!result.rows[0]) throw new Error("Proposal evaluation claim changed");
    fence.bind(started, Math.min(result.rows[0].remaining, 120000));
  }
  const writer: WorkWriter = {
    ...work,
    async lockClaim(hint) {
      return guard.operation(async () => {
        if (hint.workspaceId !== scope)
          throw new PersistenceError("scope_violation");
        if (hint.queue !== "job" || hint.kind !== "rules.proposal-evaluate")
          throw new Error("Only proposal evaluation claims are allowed");
        if (claim && (claim.id !== hint.id || claim.token !== hint.token))
          throw new Error("One evaluation claim per transaction");
        const actual = await work.lockClaim(hint);
        if (!actual || actual.attempt !== hint.attempt) return undefined;
        if (actual.kind !== hint.kind || actual.workspaceId !== scope)
          throw new PersistenceError("scope_violation");
        claim = actual;
        await assertLive();
        return actual;
      });
    },
  };
  return { writer, assertLive };
}
