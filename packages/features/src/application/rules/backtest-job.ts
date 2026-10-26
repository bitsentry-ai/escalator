import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { ruleReviewedLabelHash } from "./review-evidence.js";
import {
  ruleBacktestJobSchema,
  ruleBacktestRecordSchema,
  ruleReplayRunSchema,
  storedRuleReplaySnapshotSchema,
  ruleReplayChunkSchema,
  incidentLabelSchema,
} from "../../contracts/index.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { summarizeRuleBacktest } from "./backtest.js";
import type { RuleBacktestRepository } from "./backtest-ports.js";
export const ruleBacktestJobId = (
  scope: WorkLease["workspaceId"],
  runId: string,
) => pagingWorkId(scope, "rule-backtest", runId);
type BacktestTransaction = Parameters<
  Parameters<RuleBacktestRepository["transaction"]>[1]
>[0];
function assertBacktestClaim(
  workspaceId: WorkLease["workspaceId"],
  claim: {
    workspaceId: string;
    queue: string;
    kind: string;
    id: string;
    payload: unknown;
  },
  runId: string,
): void {
  const payload = ruleBacktestJobSchema.parse(claim.payload);
  if (
    claim.workspaceId !== workspaceId ||
    claim.queue !== "job" ||
    claim.kind !== "rules.backtest" ||
    payload.runId !== runId ||
    claim.id !== ruleBacktestJobId(workspaceId, payload.runId)
  )
    throw new Error("Invalid backtest claim");
}
/** Every persisted batch of the run, in order and bound to it, ending at the run's cursor. */
async function replayDecisions(
  tx: BacktestTransaction,
  run: ReturnType<typeof ruleReplayRunSchema.parse>,
) {
  const chunks = (await tx.reports.chunks(run.id)).map((x) =>
    ruleReplayChunkSchema.parse(x),
  );
  if (chunks.length !== run.nextBatch)
    throw new Error("Backtest chunks incomplete");
  for (const [i, c] of chunks.entries())
    if (
      c.workspaceId !== tx.workspaceId ||
      c.runId !== run.id ||
      c.snapshotId !== run.snapshotId ||
      c.batch !== i
    )
      throw new Error("Backtest chunk binding mismatch");
  const decisions = chunks.flatMap((c) => c.decisions);
  if (
    decisions.length !== run.decisionCount ||
    JSON.stringify(decisions.at(-1)?.state) !==
      JSON.stringify(run.cursor?.state)
  )
    throw new Error("Backtest decisions incomplete");
  return decisions;
}
/** Finalization is restartable and has no paging or activation effects. */
export class RuleBacktestExecution {
  constructor(private readonly repository: RuleBacktestRepository) {}
  process(lease: WorkLease): Promise<WorkResult> {
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const hint = ruleBacktestJobSchema.parse(lease.payload),
        raw = await tx.replay.lock(hint.runId);
      const run = raw ? ruleReplayRunSchema.parse(raw) : undefined;
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      assertBacktestClaim(tx.workspaceId, claim, hint.runId);
      if (!run || run.status !== "completed")
        throw new Error("Replay must complete before reporting");
      if (run.workspaceId !== tx.workspaceId || run.id !== hint.runId)
        throw new PersistenceError("scope_violation");
      const existing = await tx.reports.get(run.id);
      if (existing) {
        const row = ruleBacktestRecordSchema.parse(existing);
        if (
          row.workspaceId !== tx.workspaceId ||
          row.runId !== run.id ||
          row.inputHash !== run.inputHash ||
          row.snapshotId !== run.snapshotId
        )
          throw new PersistenceError("scope_violation");
        return { state: "completed" };
      }
      const stored = storedRuleReplaySnapshotSchema.parse(
        await tx.replay.snapshot(run.snapshotId),
      );
      if (
        stored.workspaceId !== tx.workspaceId ||
        stored.snapshot.snapshotId !== run.snapshotId ||
        stored.inputHash !== run.inputHash
      )
        throw new PersistenceError("scope_violation");
      const decisions = await replayDecisions(tx, run);
      const labels = (await tx.reports.labels(stored.snapshot)).map((x) =>
        incidentLabelSchema.parse(x),
      );
      if (
        labels.some(
          (l) =>
            l.status !== "reviewed" ||
            l.reviewedAt === null ||
            compareUtcTimestamps(l.reviewedAt, stored.snapshot.snapshotAt) > 0,
        )
      )
        throw new Error("Retrospective label in report input");
      const report = summarizeRuleBacktest(stored.snapshot, decisions, labels);
      const labelHash = ruleReviewedLabelHash(labels);
      const now = await tx.replay.currentTime();
      await tx.reports.insert(
        ruleBacktestRecordSchema.parse({
          workspaceId: tx.workspaceId,
          runId: run.id,
          snapshotId: run.snapshotId,
          inputHash: run.inputHash,
          labelHash,
          createdAt: now,
          report,
        }),
      );
      await tx.audit.append({
        id: pagingWorkId(tx.workspaceId, "rule-backtest-completed", run.id),
        workspaceId: tx.workspaceId,
        actor: { kind: "system", component: "rules" },
        action: "rule.backtest_completed",
        subjectType: "rule-replay",
        subjectId: run.id,
        recordedAt: now,
        metadata: {
          snapshotId: run.snapshotId,
          inputHash: run.inputHash,
          labelHash,
          status: report.status,
        },
      });
      if (
        compareUtcTimestamps(
          await tx.replay.currentTime(),
          claim.leaseExpiresAt,
        ) >= 0
      )
        throw new Error("Backtest lease expired");
      return { state: "completed" };
    });
  }
}
