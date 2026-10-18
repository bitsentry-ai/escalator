import { retainedReplayReader } from "./retained-replay.js";
import {
  compareUtcTimestamps,
  hasSubmillisecondTime,
} from "../../contracts/timestamps.js";
import {
  ruleReplaySnapshotSchema,
  ruleReplayCursorSchema,
  ruleReplayBudgetSchema,
  type RuleReplaySnapshot,
  type RuleReplayCursor,
  type RuleReplayBudget,
  type RuleReplayBatch,
} from "../../contracts/rule-replay.js";
import type { DetectionRule, RuleSample } from "../../contracts/rules.js";
import { advanceRuleDecision } from "../../domain/rules/advance.js";
import { ruleSampleTime, ruleWindowBounds } from "../../domain/rules/time.js";

type Interval = { startAt: string; endAt: string; recordedAt: string | null };
function intervals<T extends Interval>(input: readonly T[]): T[] {
  const rows = [...input].sort((a, b) =>
    compareUtcTimestamps(a.startAt, b.startAt),
  );
  let end: string | null = null;
  for (const row of rows) {
    if (
      (end !== null && compareUtcTimestamps(row.startAt, end) < 0) ||
      compareUtcTimestamps(row.endAt, row.startAt) <= 0
    )
      throw new Error("Replay intervals overlap or are empty");
    end = row.endAt;
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
    if (
      compareUtcTimestamps(rows[middle]!.startAt, new Date(at).toISOString()) <=
      0
    )
      low = middle + 1;
    else high = middle;
  }
  const row = rows[low - 1];
  return row &&
    compareUtcTimestamps(new Date(at).toISOString(), row.endAt) < 0 &&
    row.recordedAt !== null &&
    compareUtcTimestamps(row.recordedAt, new Date(at).toISOString()) <= 0
    ? row
    : null;
}
function after(
  rule: DetectionRule,
  samples: readonly RuleSample[],
  at: number,
): number {
  let low = 0,
    high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ruleSampleTime(rule, samples[middle]!) <= at) low = middle + 1;
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
        value !== null &&
        (hasSubmillisecondTime(value) ||
          Date.parse(value) % (rule.stepSeconds * 1000) !== 0),
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
  const retained = retainedReplayReader(snapshot);
  const samples =
    retained?.samples ??
    [...snapshot.samples].sort(
      (a, b) =>
        ruleSampleTime(snapshot.version.definition, a) -
        ruleSampleTime(snapshot.version.definition, b),
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
    const bounds = ruleWindowBounds(rule, new Date(at).toISOString());
    const from = after(rule, samples, bounds.start),
      to = after(rule, samples, bounds.end);
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
    const input = retained?.input(new Date(at).toISOString(), from, to) ?? {
      window: {
        decisionAt: new Date(at).toISOString(),
        complete: snapshot.complete,
        coverage: policy === null ? "unknown" : (segment?.state ?? "unknown"),
        samples: samples.slice(from, to),
      },
      enabled: policy?.enabled ?? true,
      maintenance: policy?.maintenance ?? false,
    };
    const decision = advanceRuleDecision(snapshot.version, state, input);
    result.decisions.push(decision);
    result.sampleVisits += to - from;
    state = decision.state;
    result.cursor = { snapshotId: snapshot.snapshotId, state };
  }
  return result;
}
