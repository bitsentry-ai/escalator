import type {
  DetectionRule,
  RuleSample,
  RuleWindowReason,
} from "../../contracts/rules.js";
interface RuleAggregate {
  value: number | null;
  reason: RuleWindowReason | null;
}
const unknown = (reason: RuleWindowReason): RuleAggregate => ({
  value: null,
  reason,
});

function metricValue(
  rule: DetectionRule,
  sample: Extract<RuleSample, { kind: "metric" }>,
): number | null {
  if (
    rule.selector.kind !== "metric" ||
    !sample.usable ||
    sample.requests === null ||
    sample.errors === null ||
    sample.errors > sample.requests
  )
    return null;
  if (rule.selector.field === "requests") return sample.requests;
  if (rule.selector.field === "errors") return sample.errors;
  return sample.requests > 0 ? sample.errors / sample.requests : null;
}
function valueOf(rule: DetectionRule, sample: RuleSample): number | null {
  if (sample.kind === "metric") return metricValue(rule, sample);
  if (sample.kind === "signal") return 1;
  if (rule.selector.kind !== "probe" || !sample.usable) return null;
  if (rule.selector.field === "duration_ms") return sample.durationMs;
  return sample.success === null ? null : Number(!sample.success);
}
/** Mean is the arithmetic mean of equally sized bins, including per-bin error
 * rates. Minimum error_rate is the existing sustained-floor interpretation;
 * no aggregation substitutes webhook counts for a request denominator.
 */
export function aggregateRuleSamples(
  rule: DetectionRule,
  samples: readonly RuleSample[],
): RuleAggregate {
  if (rule.aggregation === "count")
    return { value: samples.length, reason: null };
  let total = 0,
    minimum = Infinity,
    maximum = -Infinity,
    requests = 0;
  for (const sample of samples) {
    const value = valueOf(rule, sample);
    if (value === null) return unknown("unusable_samples");
    if (sample.kind === "metric") requests += sample.requests ?? 0;
    total += value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (total > Number.MAX_SAFE_INTEGER || requests > Number.MAX_SAFE_INTEGER)
      return unknown("unusable_samples");
  }
  if (
    rule.selector.kind === "metric" &&
    requests < rule.selector.minimumRequests
  )
    return unknown("insufficient_requests");
  if (samples.length === 0) return unknown("missing_samples");
  const values = { sum: total, mean: total / samples.length, minimum, maximum };
  return { value: values[rule.aggregation], reason: null };
}
