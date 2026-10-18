import { ceilTimestampMilliseconds } from "../../contracts/timestamps.js";
import type { DetectionRule, RuleSample } from "../../contracts/rules.js";

/** Inputs have already passed the rule/sample schemas. Periodic retained slots
 * belong to the UTC bin (end-step,end]. Keep observedAt and receivedAt intact.
 * Missing slotAt preserves the original exact-observation-grid API; explicit
 * null is handled as unknown provenance by selection, never fabricated here.
 */
export function ruleSampleTime(
  rule: DetectionRule,
  sample: RuleSample,
): number {
  if (sample.kind === "signal" || sample.slotAt == null)
    return ceilTimestampMilliseconds(sample.observedAt);
  const step = rule.stepSeconds * 1000;
  return Math.ceil(ceilTimestampMilliseconds(sample.slotAt) / step) * step;
}

export function ruleWindowBounds(rule: DetectionRule, decisionAt: string) {
  const visibleAt = Date.parse(decisionAt);
  const end = visibleAt - (rule.collectionDelaySeconds ?? 0) * 1000;
  return { start: end - rule.windowSeconds * 1000, end, visibleAt };
}
