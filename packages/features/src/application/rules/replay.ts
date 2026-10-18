import {
  ruleReplaySnapshotSchema,
  ruleReplayCursorSchema,
  ruleReplayBudgetSchema,
  type RuleReplaySnapshot,
  type RuleReplayCursor,
  type RuleReplayBudget,
  type RuleReplayBatch,
} from "../../contracts/rule-replay.js";
import type { RuleSample } from "../../contracts/rules.js";
import { advanceRuleDecision } from "../../domain/rules/advance.js";

type Interval = { startAt: string; endAt: string; recordedAt: string | null };
function intervals<T extends Interval>(input: readonly T[]): T[] {
  const rows = [...input].sort(
    (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt),
  );
  let end = -Infinity;
  for (const row of rows) {
    const start = Date.parse(row.startAt),
      next = Date.parse(row.endAt);
    if (start < end || next <= start)
      throw new Error("Replay intervals overlap or are empty");
    end = next;
  }
  return rows;
}
function visibleInterval<T extends Interval>(
  rows: readonly T[],
  at: number,
): T | null {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Date.parse(rows[middle]!.startAt) <= at) low = middle + 1;
    else high = middle;
  }
  const row = rows[low - 1];
  return row &&
    at < Date.parse(row.endAt) &&
    row.recordedAt !== null &&
    Date.parse(row.recordedAt) <= at
    ? row
    : null;
}
function after(samples: readonly RuleSample[], at: number): number {
  let low = 0,
    high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Date.parse(samples[middle]!.observedAt) <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}
function validateScope(
  snapshot: RuleReplaySnapshot,
  cursor: RuleReplayCursor | null,
): void {
  const { definition: rule, id, revision } = snapshot.version;
  if (
    cursor &&
    [
      cursor.state.lastDecisionAt,
      cursor.state.activeSince,
      cursor.state.triggerSince,
      cursor.state.recoverySince,
      cursor.state.cooldownUntil,
    ].some(
      (value) =>
        value !== null && Date.parse(value) % (rule.stepSeconds * 1000) !== 0,
    )
  )
    throw new Error("Replay cursor is not step aligned");
  if (
    snapshot.samples.some(
      (sample) =>
        sample.workspaceId !== rule.workspaceId ||
        sample.serviceId !== rule.serviceId ||
        sample.environmentId !== rule.environmentId ||
        sample.streamId !== rule.selector.streamId ||
        sample.kind !== rule.selector.kind,
    )
  )
    throw new Error("Replay sample scope mismatch");
  if (
    cursor &&
    (cursor.snapshotId !== snapshot.snapshotId ||
      cursor.state.ruleId !== id ||
      cursor.state.revision !== revision ||
      cursor.state.workspaceId !== rule.workspaceId ||
      cursor.state.serviceId !== rule.serviceId ||
      cursor.state.environmentId !== rule.environmentId ||
      Date.parse(cursor.state.lastDecisionAt) <
        Date.parse(snapshot.firstDecisionAt) ||
      Date.parse(cursor.state.lastDecisionAt) >
        Date.parse(snapshot.lastDecisionAt))
  )
    throw new Error("Replay cursor does not belong to this snapshot");
}

/** Bounded pure replay of an immutable snapshot, using exactly the live
 * transition function. Hosts persist each batch and cursor atomically and
 * must never apply replay actions to live incident/outbox tables.
 */
export function replayRuleWindows(
  raw: RuleReplaySnapshot,
  prior: RuleReplayCursor | null,
  limits: RuleReplayBudget,
  signal?: AbortSignal,
): RuleReplayBatch {
  const snapshot = ruleReplaySnapshotSchema.parse(raw),
    budget = ruleReplayBudgetSchema.parse(limits);
  const cursor = prior === null ? null : ruleReplayCursorSchema.parse(prior);
  validateScope(snapshot, cursor);
  const samples = [...snapshot.samples].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );
  const policies = intervals(snapshot.policies),
    coverage = intervals(snapshot.coverage);
  const rule = snapshot.version.definition,
    step = rule.stepSeconds * 1000;
  let state = cursor?.state ?? null,
    at =
      state === null
        ? Date.parse(snapshot.firstDecisionAt)
        : Date.parse(state.lastDecisionAt) + step;
  const end = Date.parse(snapshot.lastDecisionAt);
  const result: RuleReplayBatch = {
    evaluatorVersion: 1,
    snapshotId: snapshot.snapshotId,
    status: "complete",
    decisions: [],
    cursor,
    nextDecisionAt: null,
    sampleVisits: 0,
  };
  for (; at <= end; at += step) {
    const from = after(samples, at - rule.windowSeconds * 1000),
      to = after(samples, at);
    if (
      signal?.aborted ||
      result.decisions.length >= budget.maxDecisions ||
      result.sampleVisits + to - from > budget.maxSampleVisits
    ) {
      result.status = signal?.aborted ? "cancelled" : "budget_exhausted";
      result.nextDecisionAt = new Date(at).toISOString();
      break;
    }
    const policy = visibleInterval(policies, at),
      segment = visibleInterval(coverage, at);
    const decision = advanceRuleDecision(snapshot.version, state, {
      window: {
        decisionAt: new Date(at).toISOString(),
        complete: snapshot.complete,
        coverage: policy === null ? "unknown" : (segment?.state ?? "unknown"),
        samples: samples.slice(from, to),
      },
      enabled: policy?.enabled ?? true,
      maintenance: policy?.maintenance ?? false,
    });
    result.decisions.push(decision);
    result.sampleVisits += to - from;
    state = decision.state;
    result.cursor = { snapshotId: snapshot.snapshotId, state };
  }
  return result;
}
