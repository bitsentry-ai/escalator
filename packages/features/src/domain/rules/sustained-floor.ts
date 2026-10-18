import {
  sustainedFloorRuleSchema,
  type SustainedFloorRule,
  type SustainedFloorVerdict,
} from "../../contracts/sustained-floor.js";
import {
  metricsRangeSchema,
  type MetricsObservation,
} from "../../contracts/metrics.js";
/** Versioned pure predicate over a supplied historical window. The caller owns freshness and receipt visibility. */
export function evaluateSustainedFloor(
  input: SustainedFloorRule,
  observation: MetricsObservation,
): SustainedFloorVerdict {
  const unknown = (
    reason: SustainedFloorVerdict["reason"],
    sampleCount = 0,
  ): SustainedFloorVerdict => ({
    evaluatorVersion: 1,
    state: "insufficient_data",
    reason,
    sampleCount,
    requests: null,
    errors: null,
    minimumErrorRate: null,
  });
  const rule = sustainedFloorRuleSchema.safeParse(input);
  const range = metricsRangeSchema.safeParse(observation?.provenance?.range);
  if (!rule.success || !range.success || !Array.isArray(observation?.samples))
    return unknown("invalid_window");
  const expected = rule.data.windowSeconds / range.data.stepSeconds;
  const start = Date.parse(range.data.startAt),
    end = Date.parse(range.data.endAt);
  if (
    !Number.isInteger(expected) ||
    expected < rule.data.minimumSamples ||
    expected > 1440 ||
    end - start !== (expected - 1) * range.data.stepSeconds * 1000
  )
    return unknown("invalid_window");
  if (observation.samples.length !== expected)
    return unknown(
      "missing_samples",
      Math.min(1440, observation.samples.length),
    );
  let requests = 0,
    errors = 0,
    minimum = 1;
  for (let i = 0; i < expected; i++) {
    const sample = observation.samples[i];
    if (
      !sample ||
      typeof sample.observedAt !== "string" ||
      sample.observedAt !==
        new Date(start + i * range.data.stepSeconds * 1000).toISOString()
    )
      return unknown("missing_samples", i);
    if (
      sample.quality !== "complete" ||
      sample.requests === null ||
      sample.errors === null ||
      !Number.isFinite(sample.requests) ||
      !Number.isFinite(sample.errors) ||
      sample.requests < 0 ||
      sample.errors < 0 ||
      sample.errors > sample.requests
    )
      return unknown("unusable_samples", i);
    if (sample.requests === 0) return unknown("insufficient_requests", i);
    requests += sample.requests;
    errors += sample.errors;
    if (requests > Number.MAX_SAFE_INTEGER || errors > Number.MAX_SAFE_INTEGER)
      return unknown("unusable_samples", i);
    minimum = Math.min(minimum, sample.errors / sample.requests);
  }
  if (requests < rule.data.minimumRequests)
    return unknown("insufficient_requests", expected);
  const active = minimum >= rule.data.errorRateFloor;
  return {
    evaluatorVersion: 1,
    state: active ? "active" : "clear",
    reason: active ? "floor_met" : "below_floor",
    sampleCount: expected,
    requests,
    errors,
    minimumErrorRate: minimum,
  };
}
