import {
  opaqueIdSchema,
  utcTimestampSchema,
  replayRetentionPolicySchema,
  defaultReplayRetention,
  type WorkspaceId,
  type ReplayRetentionPolicy,
  type ReplayRetentionSettings,
} from "../../contracts/index.js";
import type { FoundationTransaction } from "../ports/persistence.js";
import { PersistenceError } from "../ports/persistence.js";
import {
  effectiveRetention,
  defaultRetentionCeilings,
} from "./policy-management.js";
import type { ReplayPruneBatch } from "./prune.js";
import { planSourceReplayPrune } from "./source-plan.js";
import { compareCodeUnits } from "../../contracts/ordering.js";
type Candidate = ReplayPruneBatch["candidates"][number];
export type ReplayPruneCursor = Pick<Candidate, "observedAt" | "kind" | "id">;
export interface ReplayPruneSnapshot {
  databaseNow: string;
  retainedBytes: number;
  policy: ReplayRetentionPolicy | null;
  candidates: Candidate[];
  hasMore: boolean;
}
export interface ReplayPruneTransaction extends FoundationTransaction {
  retentionPrune: {
    /** Source and related work locks precede accounting; policy and candidate eligibility
     * remain stable through remove(). Includes protected candidates for cursor progress.
     */
    snapshot(after: ReplayPruneCursor | null): Promise<ReplayPruneSnapshot>;
    /** Applies only selected, still-eligible snapshot records. Tombstones and terminal
     * dependencies share this transaction. Returns actual persisted counter and counts.
     */
    remove(selected: Pick<Candidate, "kind" | "id">[]): Promise<{
      deletedRows: number;
      deletedBytes: number;
      retainedBytes: number;
    }>;
  };
}
export interface ReplayPruneRepository {
  /** Locks and validates the source before entering work. Job callers lock their
   * authoritative work claim before snapshot() takes the accounting lock.
   */
  transaction<T>(
    scope: WorkspaceId,
    sourceId: string,
    work: (tx: ReplayPruneTransaction) => Promise<T>,
  ): Promise<T>;
}
function compare(left: ReplayPruneCursor, right: ReplayPruneCursor) {
  const a = `${left.kind}:${left.id}`,
    b = `${right.kind}:${right.id}`;
  const milliseconds =
    Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (milliseconds) return milliseconds;
  // Date.parse truncates below milliseconds. Preserve the database cursor's
  // fractional precision before applying the receipt identity tie-breaker.
  const leftFraction = /\.(\d+)Z$/.exec(left.observedAt)?.[1] ?? "";
  const rightFraction = /\.(\d+)Z$/.exec(right.observedAt)?.[1] ?? "";
  const width = Math.max(leftFraction.length, rightFraction.length);
  const x = leftFraction.padEnd(width, "0"),
    y = rightFraction.padEnd(width, "0");
  return compareCodeUnits(x, y) || compareCodeUnits(a, b);
}
type PruneSnapshot = Awaited<
  ReturnType<ReplayPruneTransaction["retentionPrune"]["snapshot"]>
>;
function assertPruneCursor(after: ReplayPruneCursor): void {
  opaqueIdSchema.parse(after.id);
  utcTimestampSchema.parse(after.observedAt);
  if (!["signal", "probe", "metric"].includes(after.kind))
    throw new RangeError("Invalid retention cursor kind");
}
/** The snapshot's policy must be this workspace's, and its candidates a bounded page ordered after the cursor. */
function assertPruneSnapshot(
  snapshot: PruneSnapshot,
  workspaceId: string,
  after: ReplayPruneCursor | null,
): void {
  utcTimestampSchema.parse(snapshot.databaseNow);
  if (snapshot.policy) {
    replayRetentionPolicySchema.parse(snapshot.policy);
    if (snapshot.policy.workspaceId !== workspaceId)
      throw new PersistenceError("scope_violation");
  }
  if (
    !Array.isArray(snapshot.candidates) ||
    snapshot.candidates.length > 1000 ||
    typeof snapshot.hasMore !== "boolean" ||
    (snapshot.hasMore && snapshot.candidates.length !== 1000)
  )
    throw new RangeError("Incomplete retention traversal");
  let previous = after;
  for (const row of snapshot.candidates) {
    if (previous && compare(previous, row) >= 0)
      throw new RangeError("Unordered retention candidates");
    previous = row;
  }
}
/** Where the next sweep resumes, and whether this source's sweep is complete. */
function pruneResumePoint(
  snapshot: PruneSnapshot,
  plan: ReturnType<typeof planSourceReplayPrune>,
  after: ReplayPruneCursor | null,
) {
  const previous = snapshot.candidates.at(-1) ?? after;
  // If the deletion limit was reached before the end of candidates, revisit the
  // remaining candidates instead of advancing over eligible, undeleted records.
  const selected = new Set(plan.selected.map((row) => `${row.kind}:${row.id}`));
  const firstRemaining = snapshot.candidates.findIndex(
    (row) =>
      !row.protected &&
      !selected.has(`${row.kind}:${row.id}`) &&
      (Date.parse(row.observedAt) < Date.parse(plan.cutoffAt) ||
        plan.budgetPressureAfterBatch > 0),
  );
  let lastExamined = previous;
  if (firstRemaining === 0) lastExamined = after;
  else if (firstRemaining > 0)
    lastExamined = snapshot.candidates[firstRemaining - 1];
  // Once pressure is relieved and this ordered page reaches the age cutoff,
  // later records cannot be eligible in this sweep. Avoid walking recent history.
  const last = snapshot.candidates.at(-1);
  const laterEligible =
    snapshot.hasMore &&
    (plan.budgetPressureAfterBatch > 0 ||
      !last ||
      Date.parse(last.observedAt) < Date.parse(plan.cutoffAt));
  const next =
    firstRemaining >= 0 || laterEligible
      ? lastExamined && {
          observedAt: lastExamined.observedAt,
          kind: lastExamined.kind,
          id: lastExamined.id,
        }
      : null;
  return { next, complete: firstRemaining < 0 && !laterEligible };
}
/** Internal use case; authenticated management and fenced jobs provide authorization.
 * A result is committed only after the repository transaction resolves successfully.
 */
export async function pruneReplayInTransaction(
  tx: ReplayPruneTransaction,
  sourceId: string,
  after: ReplayPruneCursor | null,
  auditId: string,
  ceilings: ReplayRetentionSettings = { ...defaultRetentionCeilings },
) {
  opaqueIdSchema.parse(sourceId);
  opaqueIdSchema.parse(auditId);
  if (after) assertPruneCursor(after);
  const snapshot = await tx.retentionPrune.snapshot(after);
  assertPruneSnapshot(snapshot, tx.workspaceId, after);
  const settings = effectiveRetention(
    snapshot.policy ?? defaultReplayRetention,
    ceilings,
  );
  const plan = planSourceReplayPrune(
    settings,
    snapshot.databaseNow,
    snapshot.retainedBytes,
    {
      workspaceId: tx.workspaceId,
      sourceId,
      limit: 100,
      candidates: snapshot.candidates,
    },
  );
  const result = plan.selected.length
    ? await tx.retentionPrune.remove(plan.selected)
    : {
        deletedRows: 0,
        deletedBytes: 0,
        retainedBytes: snapshot.retainedBytes,
      };
  if (
    result.deletedRows !== plan.selected.length ||
    result.deletedBytes !== plan.plannedBytes ||
    result.retainedBytes !== snapshot.retainedBytes - plan.plannedBytes
  )
    throw new Error("Retention deletion/accounting mismatch");
  if (result.deletedRows)
    await tx.audit.append({
      id: auditId,
      workspaceId: tx.workspaceId,
      actor: { kind: "system", component: "retention" },
      action: "retention.payloads.pruned",
      subjectType: "signal_source",
      subjectId: sourceId,
      recordedAt: tx.now,
      metadata: {
        deletedRows: result.deletedRows,
        deletedBytes: result.deletedBytes,
        policyVersion: snapshot.policy?.version ?? null,
        cutoffAt: plan.cutoffAt,
        maxBytes: settings.maxBytes,
      },
    });
  const { next, complete } = pruneResumePoint(snapshot, plan, after);
  return {
    ...result,
    overBudgetBytes: Math.max(0, result.retainedBytes - settings.maxBytes),
    next,
    complete,
  };
}
