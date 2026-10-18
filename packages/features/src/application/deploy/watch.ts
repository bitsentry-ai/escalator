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
    samples: samples.map((sample) => {
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
          Math.min(
            slot + segment.stepSeconds * 1000,
            Date.parse(segment.endAt),
          ) &&
        sample.receivedAt !== null &&
        Date.parse(sample.receivedAt) >= observed;
      const usable =
        sample.usable &&
        validTime &&
        (reading.kind === "probe"
          ? reading.state !== "unknown"
          : reading.quality === "complete");
      return { ...receipt, usable };
    }),
  });
  const summary: WatchEvidenceSummary = {
    coverage: selected.report,
    evidence: selected.samples,
    requests: kind === "metric" ? 0 : null,
    errors: kind === "metric" ? 0 : null,
    failedProbes: kind === "probe" ? 0 : null,
  };
  let longestFailureRun = 0,
    run = 0;
  let previous: (typeof selected.samples)[number] | undefined;
  let overflow = false;
  for (const sample of selected.samples) {
    const reading = readings.get(sample.id)!;
    if (reading.kind === "metric") {
      summary.requests! += reading.requests!;
      summary.errors! += reading.errors!;
      overflow ||=
        !Number.isFinite(summary.requests) ||
        summary.requests! > Number.MAX_SAFE_INTEGER ||
        summary.errors! > Number.MAX_SAFE_INTEGER;
    } else {
      if (reading.state === "failed") {
        summary.failedProbes!++;
        const interrupted =
          previous &&
          selected.report.gaps.some(
            (gap) =>
              Date.parse(gap.startAt) < Date.parse(sample.slotAt) &&
              Date.parse(gap.endAt) > Date.parse(previous!.slotAt),
          );
        run = previous && !interrupted ? run + 1 : 1;
        longestFailureRun = Math.max(longestFailureRun, run);
      } else run = 0;
      previous = sample;
    }
  }
  if (overflow) summary.requests = summary.errors = null;
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
  const revisions = new Map<number, string>();
  let configurationConflict = false;
  for (const segment of [...baseline.segments, ...watch.segments]) {
    const signature = JSON.stringify([
      segment.stepSeconds,
      at(segment.anchorAt),
      segment.recordedAt === null ? null : at(segment.recordedAt),
      segment.enabled,
    ]);
    const previous = revisions.get(segment.version);
    if (previous !== undefined && previous !== signature)
      configurationConflict = true;
    revisions.set(segment.version, signature);
  }
  if (
    configurationConflict ||
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
  let warning: WatchStreamEvaluation["reason"] | undefined;
  if (criteria.kind === "probe") {
    if (after.longestFailureRun >= criteria.failureThreshold)
      return finish("FAIL", "threshold_met");
    if (!complete) return finish("INSUFFICIENT_DATA", "watch_coverage");
    if (after.summary.failedProbes! > 0) warning = "degraded";
    else if (before.summary.failedProbes! > 0) warning = "baseline_unhealthy";
  } else {
    if (after.summary.evidence.length < criteria.watchMinimumSamples)
      return finish("INSUFFICIENT_DATA", "watch_coverage");
    if (before.overflow || after.overflow)
      return finish("INSUFFICIENT_DATA", "count_overflow");
    if (
      before.summary.requests! < criteria.minimumRequests ||
      after.summary.requests! < criteria.minimumRequests
    )
      return finish(
        "INSUFFICIENT_DATA",
        complete ? "insufficient_requests" : "watch_coverage",
      );
    const baselineRate = before.summary.errors! / before.summary.requests!,
      watchRate = after.summary.errors! / after.summary.requests!;
    const threshold = Math.min(
      1,
      Math.max(
        criteria.errorRateFloor,
        baselineRate * criteria.relativeMultiplier,
        baselineRate + criteria.absoluteIncrease,
      ),
    );
    result.baselineErrorRate = baselineRate;
    result.watchErrorRate = watchRate;
    result.effectiveErrorRateThreshold = threshold;
    if (watchRate > baselineRate && watchRate >= threshold)
      return finish("FAIL", "threshold_met");
    if (!complete) return finish("INSUFFICIENT_DATA", "watch_coverage");
    if (watchRate > baselineRate) warning = "degraded";
    else if (baselineRate >= criteria.errorRateFloor)
      warning = "baseline_unhealthy";
  }
  if (!result.final) return finish("PENDING", "observing");
  return warning ? finish("WARN", warning) : finish("PASS", "stable");
}
