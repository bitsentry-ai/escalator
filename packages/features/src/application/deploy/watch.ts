import {
  watchStreamEvidenceSchema,
  watchCriteriaSchema,
  deploymentBaselineSeconds,
  deploymentWatchSeconds,
  deploymentWatchReceiptGraceSeconds,
  type WatchEvidenceWindow,
  type WatchStreamEvidence,
  type WatchStreamEvaluation,
  type WatchEvidenceSummary,
  type WatchCriteria,
} from "../../contracts/deploy-watch.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import type { Probe } from "../../contracts/probes.js";
import type { MetricMonitor } from "../../contracts/metric-records.js";
import { expectDefined } from "../../contracts/expect-defined.js";
import { selectPeriodicCoverage } from "../retention/coverage.js";

export function probeWatchCriteria(
  probe: Pick<Probe, "critical" | "failureThreshold">,
): WatchCriteria {
  return watchCriteriaSchema.parse({
    version: 1,
    kind: "probe",
    baselineMinimumSamples: 3,
    failureThreshold: probe.critical ? 1 : probe.failureThreshold,
  });
}
export function metricWatchCriteria(
  monitor: Pick<MetricMonitor, "rule">,
): WatchCriteria {
  return watchCriteriaSchema.parse({
    version: 1,
    kind: "metric",
    baselineMinimumSamples: 3,
    watchMinimumSamples: 3,
    minimumRequests: monitor.rule.minimumRequests,
    errorRateFloor: monitor.rule.errorRateFloor,
    relativeMultiplier: 2,
    absoluteIncrease: 0.01,
  });
}
/** A receipt counts only when its reading arrived on time inside its configuration segment and is usable. */
function coverageReceipt(
  window: WatchEvidenceWindow,
  kind: WatchCriteria["kind"],
  sample: WatchEvidenceWindow["samples"][number],
) {
  const { reading, ...receipt } = sample;
  if (reading.kind !== kind)
    throw new RangeError("Watch evidence kind differs");
  const slot = Date.parse(sample.slotAt);
  const segment = window.segments.find(
    (value) =>
      value.version === sample.version &&
      slot >= Date.parse(value.startAt) &&
      slot < Date.parse(value.endAt),
  );
  const observed = Date.parse(sample.observedAt);
  const validTime =
    segment !== undefined &&
    observed >= slot &&
    observed <
      Math.min(slot + segment.stepSeconds * 1000, Date.parse(segment.endAt)) &&
    sample.receivedAt !== null &&
    Date.parse(sample.receivedAt) >= observed;
  const usable =
    sample.usable &&
    validTime &&
    (reading.kind === "probe"
      ? reading.state !== "unknown"
      : reading.quality === "complete");
  return { ...receipt, usable };
}
/** A failed probe extends the streak unless a coverage gap separates it from the previous probe. */
function extendFailureRun(
  run: number,
  previous: { slotAt: string } | undefined,
  sample: { slotAt: string },
  gaps: readonly { startAt: string; endAt: string }[],
): number {
  if (previous === undefined) return 1;
  const interrupted = gaps.some(
    (gap) =>
      Date.parse(gap.startAt) < Date.parse(sample.slotAt) &&
      Date.parse(gap.endAt) > Date.parse(previous.slotAt),
  );
  return interrupted ? 1 : run + 1;
}
function summarize(window: WatchEvidenceWindow, kind: WatchCriteria["kind"]) {
  const { samples } = window;
  if (
    window.segments.some(
      (segment) => segment.stepSeconds < 60 || segment.stepSeconds > 3600,
    )
  )
    throw new RangeError("Invalid watch sampling interval");
  const readings = new Map(
    samples.map((sample) => [sample.id, sample.reading]),
  );
  const selected = selectPeriodicCoverage({
    workspaceId: window.workspaceId,
    streamId: window.streamId,
    startAt: window.startAt,
    endAt: window.endAt,
    visibleAt: window.visibleAt,
    complete: window.complete,
    segments: window.segments,
    samples: samples.map((sample) => coverageReceipt(window, kind, sample)),
  });
  let requests = 0,
    errors = 0,
    failedProbes = 0;
  let longestFailureRun = 0,
    run = 0;
  let previous: (typeof selected.samples)[number] | undefined;
  let overflow = false;
  for (const sample of selected.samples) {
    const reading = expectDefined(readings.get(sample.id), "watch reading");
    if (reading.kind === "metric") {
      // An unusable reading has null counts, which add nothing.
      requests += reading.requests ?? 0;
      errors += reading.errors ?? 0;
      overflow ||=
        !Number.isFinite(requests) ||
        requests > Number.MAX_SAFE_INTEGER ||
        errors > Number.MAX_SAFE_INTEGER;
    } else {
      if (reading.state === "failed") {
        failedProbes++;
        run = extendFailureRun(run, previous, sample, selected.report.gaps);
        longestFailureRun = Math.max(longestFailureRun, run);
      } else run = 0;
      previous = sample;
    }
  }
  const counted = kind === "metric" && !overflow;
  const summary: WatchEvidenceSummary = {
    coverage: selected.report,
    evidence: selected.samples,
    requests: counted ? requests : null,
    errors: counted ? errors : null,
    failedProbes: kind === "probe" ? failedProbes : null,
  };
  return { summary, overflow, longestFailureRun };
}
function covered(summary: WatchEvidenceSummary, minimum: number) {
  return (
    summary.coverage.queryComplete &&
    summary.coverage.gaps.length === 0 &&
    summary.coverage.expectedSlots >= minimum &&
    summary.coverage.availableSlots === summary.coverage.expectedSlots
  );
}
type Verdict = WatchStreamEvaluation["verdict"];
type Reason = WatchStreamEvaluation["reason"];
type WindowSummary = ReturnType<typeof summarize>;
/** A stream either has its verdict already, or passes with an optional warning once the watch is final. */
type StreamOutcome =
  | { verdict: Verdict; reason: Reason }
  | { warning: Reason | undefined };
type ErrorRates = { baseline: number; watch: number; threshold: number };
function assertWatchChronology(scope: WorkspaceId, value: WatchStreamEvidence) {
  const { baseline, watch } = value;
  const at = Date.parse;
  const end = at(value.watchEndsAt),
    evaluated = at(value.evaluatedAt);
  const cutoff = end + deploymentWatchReceiptGraceSeconds * 1000;
  if (
    baseline.workspaceId !== scope ||
    watch.workspaceId !== scope ||
    baseline.streamId !== watch.streamId
  )
    throw new RangeError("Watch evidence scope differs");
  if (
    at(baseline.endAt) !== at(value.deploymentStartedAt) ||
    at(baseline.endAt) - at(baseline.startAt) !==
      deploymentBaselineSeconds * 1000 ||
    at(baseline.visibleAt) > at(watch.startAt) ||
    at(baseline.endAt) > at(watch.startAt) ||
    end - at(watch.startAt) !== deploymentWatchSeconds * 1000 ||
    at(watch.endAt) !== Math.min(evaluated, end) ||
    at(watch.visibleAt) !== Math.min(evaluated, cutoff)
  )
    throw new RangeError("Invalid deployment watch chronology");
}
/** True when one configuration version shows different settings in the baseline and the watch. */
function configurationChanged(
  baseline: WatchEvidenceWindow,
  watch: WatchEvidenceWindow,
): boolean {
  const at = Date.parse;
  const revisions = new Map<number, string>();
  for (const segment of [...baseline.segments, ...watch.segments]) {
    const signature = JSON.stringify([
      segment.stepSeconds,
      at(segment.anchorAt),
      segment.recordedAt === null ? null : at(segment.recordedAt),
      segment.enabled,
    ]);
    const previous = revisions.get(segment.version);
    if (previous !== undefined && previous !== signature) return true;
    revisions.set(segment.version, signature);
  }
  return false;
}
function probeOutcome(
  criteria: Extract<WatchCriteria, { kind: "probe" }>,
  before: WindowSummary,
  after: WindowSummary,
  complete: boolean,
): StreamOutcome {
  if (after.longestFailureRun >= criteria.failureThreshold)
    return { verdict: "FAIL", reason: "threshold_met" };
  if (!complete)
    return { verdict: "INSUFFICIENT_DATA", reason: "watch_coverage" };
  if ((after.summary.failedProbes ?? 0) > 0) return { warning: "degraded" };
  if ((before.summary.failedProbes ?? 0) > 0)
    return { warning: "baseline_unhealthy" };
  return { warning: undefined };
}
function metricOutcome(
  criteria: Extract<WatchCriteria, { kind: "metric" }>,
  before: WindowSummary,
  after: WindowSummary,
  complete: boolean,
): StreamOutcome & { rates?: ErrorRates } {
  if (after.summary.evidence.length < criteria.watchMinimumSamples)
    return { verdict: "INSUFFICIENT_DATA", reason: "watch_coverage" };
  if (before.overflow || after.overflow)
    return { verdict: "INSUFFICIENT_DATA", reason: "count_overflow" };
  const baselineRequests = before.summary.requests ?? 0,
    watchRequests = after.summary.requests ?? 0;
  if (
    baselineRequests < criteria.minimumRequests ||
    watchRequests < criteria.minimumRequests
  )
    return {
      verdict: "INSUFFICIENT_DATA",
      reason: complete ? "insufficient_requests" : "watch_coverage",
    };
  const baselineRate = (before.summary.errors ?? 0) / baselineRequests,
    watchRate = (after.summary.errors ?? 0) / watchRequests;
  const threshold = Math.min(
    1,
    Math.max(
      criteria.errorRateFloor,
      baselineRate * criteria.relativeMultiplier,
      baselineRate + criteria.absoluteIncrease,
    ),
  );
  const rates = { baseline: baselineRate, watch: watchRate, threshold };
  if (watchRate > baselineRate && watchRate >= threshold)
    return { verdict: "FAIL", reason: "threshold_met", rates };
  if (!complete)
    return { verdict: "INSUFFICIENT_DATA", reason: "watch_coverage", rates };
  if (watchRate > baselineRate) return { warning: "degraded", rates };
  if (baselineRate >= criteria.errorRateFloor)
    return { warning: "baseline_unhealthy", rates };
  return { warning: undefined, rates };
}
/** Pure evaluation of one captured stream. Hosts persist baseline snapshots before
 * starting the deployment and fence evidence by these cutoffs. This function does
 * not read a provider, infer causality, create an incident or activate a watch.
 */
export function evaluateWatchStream(
  scope: WorkspaceId,
  raw: WatchStreamEvidence,
): WatchStreamEvaluation {
  const value = watchStreamEvidenceSchema.parse(raw);
  const { baseline, watch, criteria } = value;
  const at = Date.parse;
  const end = at(value.watchEndsAt),
    evaluated = at(value.evaluatedAt);
  const cutoff = end + deploymentWatchReceiptGraceSeconds * 1000;
  assertWatchChronology(scope, value);
  const before = summarize(baseline, criteria.kind),
    after = summarize(watch, criteria.kind);
  const result: WatchStreamEvaluation = {
    evaluatorVersion: 1,
    streamId: watch.streamId,
    criteria,
    evaluatedAt: value.evaluatedAt,
    final: evaluated >= cutoff && at(watch.endAt) === end,
    verdict: "INSUFFICIENT_DATA",
    reason: "baseline_coverage",
    baseline: before.summary,
    watch: after.summary,
    baselineErrorRate: null,
    watchErrorRate: null,
    effectiveErrorRateThreshold: null,
    longestFailureRun:
      criteria.kind === "probe" ? after.longestFailureRun : null,
  };
  const finish = (
    verdict: WatchStreamEvaluation["verdict"],
    reason: WatchStreamEvaluation["reason"],
  ): WatchStreamEvaluation => ({ ...result, verdict, reason });
  if (
    configurationChanged(baseline, watch) ||
    !baseline.configurationCompatible ||
    !watch.configurationCompatible
  )
    return finish("INSUFFICIENT_DATA", "configuration_changed");
  if (!covered(before.summary, criteria.baselineMinimumSamples)) return result;
  if (!after.summary.coverage.queryComplete)
    return finish("INSUFFICIENT_DATA", "watch_coverage");
  // Watch gaps cannot hide a failure already met by usable evidence; only
  // PASS/WARN need every scheduled watch slot. Probe streaks reset at gaps.
  const complete = covered(
    after.summary,
    criteria.kind === "metric" ? criteria.watchMinimumSamples : 1,
  );
  const outcome: StreamOutcome & { rates?: ErrorRates } =
    criteria.kind === "probe"
      ? probeOutcome(criteria, before, after, complete)
      : metricOutcome(criteria, before, after, complete);
  if (outcome.rates) {
    result.baselineErrorRate = outcome.rates.baseline;
    result.watchErrorRate = outcome.rates.watch;
    result.effectiveErrorRateThreshold = outcome.rates.threshold;
  }
  if ("verdict" in outcome) return finish(outcome.verdict, outcome.reason);
  if (!result.final) return finish("PENDING", "observing");
  return outcome.warning
    ? finish("WARN", outcome.warning)
    : finish("PASS", "stable");
}
