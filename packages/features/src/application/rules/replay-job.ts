import type { z } from "zod";
import { ruleBacktestJobId } from "./backtest-job.js";
import {
  ruleReplayRunSchema,
  ruleReplayJobSchema,
  ruleReplayChunkSchema,
  storedRuleReplaySnapshotSchema,
  type RuleReplayRun,
} from "../../contracts/replay-run.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type {
  RuleReplayRepository,
  RuleReplayTransaction,
} from "./replay-ports.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { replayRuleWindows } from "./replay.js";
export function ruleReplayJobId(
  scope: WorkspaceId,
  runId: string,
  batch: number,
) {
  return pagingWorkId(scope, "rule-replay", runId, String(batch));
}
export async function enqueueRuleReplay(
  tx: RuleReplayTransaction,
  raw: RuleReplayRun,
) {
  const row = ruleReplayRunSchema.parse(raw);
  if (row.workspaceId !== tx.workspaceId)
    throw new PersistenceError("scope_violation");
  if (row.status !== "queued" && row.status !== "running")
    throw new Error("Replay is terminal");
  const id = ruleReplayJobId(tx.workspaceId, row.id, row.nextBatch);
  await tx.work.enqueue("job", {
    id,
    kind: "rules.replay",
    priority: -100,
    idempotencyKey: id,
    dueAt: row.updatedAt,
    payload: { runId: row.id, batch: row.nextBatch },
  });
}
type ReplayRun = z.infer<typeof ruleReplayRunSchema>;
function assertReplayClaim(
  workspaceId: WorkspaceId,
  claim: { workspaceId: string; queue: string; kind: string; id: string },
  payload: z.infer<typeof ruleReplayJobSchema>,
  runId: string,
): void {
  if (
    claim.workspaceId !== workspaceId ||
    claim.queue !== "job" ||
    claim.kind !== "rules.replay" ||
    payload.runId !== runId ||
    claim.id !== ruleReplayJobId(workspaceId, payload.runId, payload.batch)
  )
    throw new Error("Invalid replay claim");
}
/** The run's frozen snapshot, captured before the run, with the run's cursor at its recorded decision count. */
async function runSnapshot(tx: RuleReplayTransaction, row: ReplayRun) {
  const source = await tx.replay.snapshot(row.snapshotId);
  if (!source) throw new Error("Replay snapshot unavailable");
  const stored = storedRuleReplaySnapshotSchema.parse(source);
  const snapshot = stored.snapshot;
  if (
    stored.workspaceId !== tx.workspaceId ||
    snapshot.snapshotId !== row.snapshotId ||
    stored.inputHash !== row.inputHash
  )
    throw new PersistenceError("scope_violation");
  if (compareUtcTimestamps(snapshot.snapshotAt, row.createdAt) > 0)
    throw new Error("Replay snapshot follows run creation");
  const step = snapshot.version.definition.stepSeconds * 1000;
  const expectedPrior =
    Date.parse(snapshot.firstDecisionAt) + (row.decisionCount - 1) * step;
  if (
    row.cursor &&
    Date.parse(row.cursor.state.lastDecisionAt) !== expectedPrior
  )
    throw new Error("Replay cursor/count mismatch");
  return snapshot;
}
/** Resumable deterministic computation. Each job advances one bounded batch;
 * lease loss, CAS failure or cancellation cannot commit a partial result. */
export class RuleReplayExecution {
  constructor(private readonly repository: RuleReplayRepository) {}
  process(lease: WorkLease): Promise<WorkResult> {
    const hint = ruleReplayJobSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const raw = await tx.replay.lock(hint.runId);
      const row = raw ? ruleReplayRunSchema.parse(raw) : undefined;
      if (row && (row.workspaceId !== tx.workspaceId || row.id !== hint.runId))
        throw new PersistenceError("scope_violation");
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      const payload = ruleReplayJobSchema.parse(claim.payload);
      assertReplayClaim(tx.workspaceId, claim, payload, hint.runId);
      if (
        !row ||
        row.status === "completed" ||
        row.status === "cancelled" ||
        row.nextBatch !== payload.batch
      )
        return { state: "completed" };
      const snapshot = await runSnapshot(tx, row);
      const batch = replayRuleWindows(snapshot, row.cursor, {
        maxDecisions: 60,
        maxSampleVisits: 100000,
      });
      if (
        !batch.decisions.length ||
        !batch.cursor ||
        batch.status === "cancelled"
      )
        throw new Error("Replay did not advance");
      const next = ruleReplayRunSchema.parse({
        ...row,
        revision: row.revision + 1,
        status: batch.status === "complete" ? "completed" : "running",
        nextBatch: row.nextBatch + 1,
        cursor: batch.cursor,
        decisionCount: row.decisionCount + batch.decisions.length,
        updatedAt: await tx.replay.currentTime(),
      });
      await tx.replay.append(
        ruleReplayChunkSchema.parse({
          workspaceId: tx.workspaceId,
          runId: row.id,
          batch: row.nextBatch,
          snapshotId: row.snapshotId,
          decisions: batch.decisions,
        }),
      );
      if (!(await tx.replay.save(next, row.revision)))
        throw new Error("Replay revision conflict");
      if (next.status !== "completed") await enqueueRuleReplay(tx, next);
      else {
        await tx.audit.append({
          id: pagingWorkId(tx.workspaceId, "rule-replay-completed", row.id),
          workspaceId: tx.workspaceId,
          actor: { kind: "system", component: "rules" },
          action: "rule.replay_completed",
          subjectType: "rule-replay",
          subjectId: row.id,
          recordedAt: next.updatedAt,
          metadata: {
            snapshotId: row.snapshotId,
            decisionCount: next.decisionCount,
            evaluatorVersion: 1,
          },
        });
        const reportId = ruleBacktestJobId(tx.workspaceId, row.id);
        await tx.work.enqueue("job", {
          id: reportId,
          kind: "rules.backtest",
          idempotencyKey: reportId,
          dueAt: next.updatedAt,
          priority: -100,
          payload: { runId: row.id },
        });
      }
      if (
        compareUtcTimestamps(
          await tx.replay.currentTime(),
          claim.leaseExpiresAt,
        ) >= 0
      )
        throw new Error("Replay lease expired before commit");
      return { state: "completed" };
    });
  }
}
