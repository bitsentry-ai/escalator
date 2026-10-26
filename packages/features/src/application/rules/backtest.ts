import { compareRecordedRules } from "./compare.js";
import { backtestAvailability } from "./backtest-availability.js";
import { ruleBacktestReportSchema } from "../../contracts/rule-backtest.js";
import { z } from "zod";
import {
  incidentLabelSchema,
  type IncidentLabel,
} from "../../contracts/rule-label.js";
import { persistedRuleTransitionSchema } from "../../contracts/replay-run.js";
import {
  ruleReplaySnapshotSchema,
  type RuleReplaySnapshot,
} from "../../contracts/rule-replay.js";
import type { RuleTransition } from "../../contracts/rule-state.js";
import type {
  BacktestEpisode,
  RuleBacktestReport,
} from "../../contracts/rule-backtest.js";
import {
  compareUtcTimestamps,
  hasSubmillisecondTime,
} from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
function backtestReason(
  inputComplete: boolean,
  evaluated: number,
  partial: boolean,
): "incomplete_input" | "no_usable_history" | "partial_history" | "complete" {
  if (!inputComplete) return "incomplete_input";
  if (evaluated === 0) return "no_usable_history";
  if (partial) return "partial_history";
  return "complete";
}
type ReplayDecision = z.infer<typeof persistedRuleTransitionSchema>;
const usableDecision = (d: RuleTransition) =>
  d.status === "evaluated" &&
  d.verdict !== null &&
  d.verdict.state !== "insufficient_data";
/** Rejects a decision outside the rule's scope or out of its place in the contiguous replay. */
function assertContiguousDecision(
  snapshot: RuleReplaySnapshot,
  d: ReplayDecision,
  index: number,
  step: number,
): void {
  const definition = snapshot.version.definition;
  const s = d.state;
  if (
    s.workspaceId !== definition.workspaceId ||
    s.serviceId !== definition.serviceId ||
    s.environmentId !== definition.environmentId ||
    s.ruleId !== snapshot.version.id ||
    s.revision !== snapshot.version.revision
  )
    throw new PersistenceError("scope_violation");
  if (
    hasSubmillisecondTime(s.lastDecisionAt) ||
    Date.parse(s.lastDecisionAt) !==
      Date.parse(snapshot.firstDecisionAt) + index * step ||
    d.status === "duplicate" ||
    d.status === "stale"
  )
    throw new Error("Non-contiguous replay decisions");
}
function assertOpening(
  d: ReplayDecision,
  active: BacktestEpisode | undefined,
): void {
  if (
    active ||
    d.episodeStartedAt !== d.state.lastDecisionAt ||
    d.status !== "evaluated" ||
    d.verdict?.state !== "trigger"
  )
    throw new Error("Inconsistent episode opening");
}
function assertRecovery(
  d: ReplayDecision,
  active: BacktestEpisode | undefined,
): BacktestEpisode {
  if (
    !active ||
    d.episodeStartedAt !== active.startedAt ||
    d.status !== "evaluated" ||
    d.verdict?.state !== "recovery"
  )
    throw new Error("Inconsistent episode recovery");
  return active;
}
/** Replays the persisted decisions into alert episodes, rejecting gaps and inconsistent transitions. */
function replayEpisodes(
  snapshot: RuleReplaySnapshot,
  decisions: readonly ReplayDecision[],
): BacktestEpisode[] {
  const step = snapshot.version.definition.stepSeconds * 1000;
  const episodes: BacktestEpisode[] = [];
  let active: BacktestEpisode | undefined;
  for (const [i, d] of decisions.entries()) {
    assertContiguousDecision(snapshot, d, i, step);
    const s = d.state;
    if (d.action === "opened") {
      assertOpening(d, active);
      active = {
        startedAt: s.lastDecisionAt,
        endedAt: null,
        outcome: "unreviewed",
        labelId: null,
      };
      episodes.push(active);
    } else if (d.action === "recovered") {
      const recovered = assertRecovery(d, active);
      recovered.endedAt = s.lastDecisionAt;
      active = undefined;
    }
    if (s.activeSince !== (active?.startedAt ?? null))
      throw new Error("Episode state does not match replay actions");
  }
  return episodes;
}
function assertLabelScope(
  snapshot: RuleReplaySnapshot,
  labels: readonly IncidentLabel[],
): void {
  const definition = snapshot.version.definition;
  const ids = new Set<string>();
  for (const label of labels) {
    if (
      label.workspaceId !== definition.workspaceId ||
      label.serviceId !== definition.serviceId ||
      label.environmentId !== definition.environmentId ||
      label.stream.kind !== definition.selector.kind ||
      label.stream.id !== definition.selector.streamId
    )
      throw new PersistenceError("scope_violation");
    if (ids.has(label.id)) throw new Error("Duplicate incident label");
    ids.add(label.id);
  }
}
/** The first index whose value is not below `value` (or not above it, when inclusive); null sorts last. */
function lowerBound(
  rows: readonly (string | null)[],
  value: string,
  inclusive: boolean,
): number {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const order =
      rows[mid] === null ? 1 : compareUtcTimestamps(rows[mid], value);
    if (order < 0 || (inclusive && order === 0)) low = mid + 1;
    else high = mid;
  }
  return low;
}
/**
 * Gives each episode the outcome of the one reviewed label that overlaps only it. Episodes are ordered and
 * non-overlapping, so range additions avoid materializing the potentially quadratic overlap graph.
 */
function matchEpisodes(
  episodes: BacktestEpisode[],
  reviewed: readonly IncidentLabel[],
  end: string,
): { matched: Set<string>; ambiguous: number } {
  const starts = episodes.map((e) => e.startedAt);
  const ends = episodes.map((e) => e.endedAt);
  const additions = new Int32Array(episodes.length + 1),
    candidate = new Map<number, IncidentLabel>(),
    matched = new Set<string>();
  for (const label of reviewed) {
    const first = lowerBound(ends, label.startedAt, true);
    const last = lowerBound(starts, label.endedAt, false);
    if (first >= last || compareUtcTimestamps(label.startedAt, end) > 0)
      continue;
    matched.add(label.id);
    additions[first] = additions[first] + 1;
    additions[last] = additions[last] - 1;
    if (last - first === 1) candidate.set(first, label);
  }
  let ambiguous = 0,
    overlaps = 0;
  for (const [i, e] of episodes.entries()) {
    overlaps += additions[i];
    const label = candidate.get(i);
    if (overlaps === 1 && label) {
      e.outcome = label.outcome;
      e.labelId = label.id;
    } else if (overlaps) ambiguous++;
  }
  return { matched, ambiguous };
}
/** An unmatched actionable label is missed only when the replay fully and usably covers it. */
function classifyUnmatched(
  snapshot: RuleReplaySnapshot,
  decisions: readonly ReplayDecision[],
  unmatched: readonly IncidentLabel[],
  warmupUntil: string,
): { missed: string[]; unevaluable: string[] } {
  const end = snapshot.lastDecisionAt;
  const decisionTimes = decisions.map((d) => d.state.lastDecisionAt);
  const unavailable = [0];
  for (const d of decisions)
    unavailable.push(
      unavailable[unavailable.length - 1] + (usableDecision(d) ? 0 : 1),
    );
  const missed: string[] = [],
    unevaluable: string[] = [];
  for (const label of unmatched) {
    const covered =
      compareUtcTimestamps(label.startedAt, warmupUntil) >= 0 &&
      compareUtcTimestamps(label.endedAt, end) <= 0;
    const first = lowerBound(decisionTimes, label.startedAt, false),
      last = lowerBound(decisionTimes, label.endedAt, false);
    if (
      snapshot.complete &&
      covered &&
      last > first &&
      unavailable[last] === unavailable[first]
    )
      missed.push(label.id);
    else unevaluable.push(label.id);
  }
  return { missed, unevaluable };
}
/** The Wilson score interval for precision at 95% confidence, or null without reviewed episodes. */
function wilson95(tp: number, n: number): { low: number; high: number } | null {
  if (!n) return null;
  const p = tp / n,
    z95 = 1.959963984540054,
    z2 = z95 * z95,
    denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom,
    margin = (z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}
/** Reviewed intervals are [start,end); episodes overlap them from opening until
 * recovery. An unmatched episode is unreviewed, never an inferred false positive.
 * Ambiguous many-to-one/one-to-many overlaps remain unadjudicated. */
export function summarizeRuleBacktest(
  rawSnapshot: RuleReplaySnapshot,
  rawDecisions: readonly RuleTransition[],
  rawLabels: readonly IncidentLabel[],
): RuleBacktestReport {
  const snapshot = ruleReplaySnapshotSchema.parse(rawSnapshot);
  const decisions = z
    .array(persistedRuleTransitionSchema)
    .max(44641)
    .parse(rawDecisions);
  const labels = z.array(incidentLabelSchema).max(1000).parse(rawLabels);
  const definition = snapshot.version.definition,
    step = definition.stepSeconds * 1000;
  const expected =
    (Date.parse(snapshot.lastDecisionAt) -
      Date.parse(snapshot.firstDecisionAt)) /
      step +
    1;
  if (decisions.length !== expected)
    throw new Error("Backtest requires every persisted replay decision");
  const episodes = replayEpisodes(snapshot, decisions);
  assertLabelScope(snapshot, labels);
  const reviewed = labels.filter(
    (l) =>
      l.status === "reviewed" &&
      l.reviewedAt !== null &&
      compareUtcTimestamps(l.reviewedAt, snapshot.snapshotAt) <= 0,
  );
  const end = snapshot.lastDecisionAt;
  const warmupUntil = new Date(
    Date.parse(snapshot.firstDecisionAt) + definition.persistenceSeconds * 1000,
  ).toISOString();
  const { matched, ambiguous } = matchEpisodes(episodes, reviewed, end);
  const evaluated = decisions.filter(usableDecision).length,
    suppressed = decisions.filter((d) => d.status === "suppressed").length;
  const { missed, unevaluable } = classifyUnmatched(
    snapshot,
    decisions,
    reviewed.filter(
      (label) => label.outcome === "actionable" && !matched.has(label.id),
    ),
    warmupUntil,
  );
  const tp = episodes.filter((e) => e.outcome === "actionable").length,
    fp = episodes.filter((e) => e.outcome === "noise").length,
    n = tp + fp;
  const report = ruleBacktestReportSchema.parse({
    availability: backtestAvailability(decisions),
    version: 1,
    evaluatorVersion: 1,
    ...(snapshot.evaluation ? { evaluation: snapshot.evaluation } : {}),
    ...(snapshot.candidateEvaluation
      ? { candidateEvaluation: snapshot.candidateEvaluation }
      : {}),
    matchingPolicy: "unique-overlap-v1",
    snapshotId: snapshot.snapshotId,
    rule: snapshot.version,
    status:
      snapshot.complete && evaluated > 0 ? "BACKTESTED" : "NOT_BACKTESTABLE",
    simulation: { initialState: "inactive", warmupUntil },
    reason: backtestReason(
      snapshot.complete,
      evaluated,
      evaluated + suppressed < decisions.length,
    ),
    range: { firstDecisionAt: snapshot.firstDecisionAt, lastDecisionAt: end },
    coverage: {
      totalDecisions: decisions.length,
      evaluatedDecisions: evaluated,
      suppressedDecisions: suppressed,
      unknownDecisions: decisions.length - evaluated - suppressed,
      fraction: evaluated / decisions.length,
    },
    episodes,
    reviewedLabels: reviewed.length,
    unreviewedEpisodes: episodes.length - n,
    ambiguousEpisodes: ambiguous,
    truePositives: tp,
    falsePositives: fp,
    missedLabelIds: missed.sort(),
    unevaluableLabelIds: unevaluable.sort(),
    precision: {
      value: n ? tp / n : null,
      denominator: n,
      wilson95: wilson95(tp, n),
    },
    labelCoverage: episodes.length ? n / episodes.length : null,
  });
  return { ...report, comparison: compareRecordedRules(snapshot, report) };
}
