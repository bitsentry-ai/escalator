import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import type {
  DetectionRule,
  RuleSample,
  RuleWindow,
  RuleWindowReason,
} from "../../contracts/rules.js";
import { ruleSampleTime, ruleWindowBounds } from "./time.js";
import { compareCodeUnits } from "../../contracts/ordering.js";

export interface SelectedRuleSamples {
  samples: RuleSample[];
  lateCount: number;
  retrospectiveCount: number;
  reason: RuleWindowReason | null;
}
/** Reject mixed authorization scopes rather than silently filtering a faulty adapter. */
function matches(rule: DetectionRule, sample: RuleSample): boolean {
  return (
    sample.workspaceId === rule.workspaceId &&
    sample.serviceId === rule.serviceId &&
    sample.environmentId === rule.environmentId &&
    sample.streamId === rule.selector.streamId &&
    sample.kind === rule.selector.kind
  );
}
export function selectRuleSamples(
  rule: DetectionRule,
  window: RuleWindow,
): SelectedRuleSamples {
  const result: SelectedRuleSamples = {
    samples: [],
    lateCount: 0,
    retrospectiveCount: 0,
    reason: null,
  };
  const { start, end } = ruleWindowBounds(rule, window.decisionAt);
  const ids = new Set<string>(),
    slots = new Set<number>();
  for (const sample of window.samples) {
    if (!matches(rule, sample)) {
      result.reason = "scope_mismatch";
      return result;
    }
    const slot = ruleSampleTime(rule, sample);
    if (slot <= start || slot > end) continue;
    if (sample.kind !== "signal" && sample.slotAt === null) {
      result.retrospectiveCount++;
      continue;
    }
    if (sample.receivedAt === null) {
      result.retrospectiveCount++;
      continue;
    }
    if (compareUtcTimestamps(sample.receivedAt, window.decisionAt) > 0) {
      result.lateCount++;
      continue;
    }
    if (
      sample.kind !== "signal" &&
      typeof sample.slotAt === "string" &&
      (compareUtcTimestamps(sample.slotAt, sample.observedAt) > 0 ||
        compareUtcTimestamps(sample.observedAt, sample.receivedAt) > 0)
    ) {
      result.reason = "invalid_input";
      return result;
    }
    // Every visible observation must have one identity and one periodic slot.
    if (ids.has(sample.id) || (sample.kind !== "signal" && slots.has(slot))) {
      result.reason = "conflicting_samples";
      return result;
    }
    ids.add(sample.id);
    slots.add(slot);
    if (sample.kind !== "signal" && slot % (rule.stepSeconds * 1000) !== 0) {
      result.reason = "unaligned_window";
      return result;
    }
    result.samples.push(sample);
  }
  result.samples.sort(
    (a, b) =>
      compareUtcTimestamps(a.observedAt, b.observedAt) ||
      compareCodeUnits(a.id, b.id),
  );
  return result;
}
