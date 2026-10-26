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
/**
 * A sample without a receipt time or periodic slot is retrospective; one received after the decision is late; one
 * observed before its slot or received before it was observed is invalid.
 */
function sampleTiming(
  sample: RuleWindow["samples"][number],
  decisionAt: string,
): "retrospective" | "late" | "invalid" | "visible" {
  if (sample.kind !== "signal" && sample.slotAt === null)
    return "retrospective";
  if (sample.receivedAt === null) return "retrospective";
  if (compareUtcTimestamps(sample.receivedAt, decisionAt) > 0) return "late";
  if (
    sample.kind !== "signal" &&
    typeof sample.slotAt === "string" &&
    (compareUtcTimestamps(sample.slotAt, sample.observedAt) > 0 ||
      compareUtcTimestamps(sample.observedAt, sample.receivedAt) > 0)
  )
    return "invalid";
  return "visible";
}
/** Every visible observation must have one identity and one step-aligned periodic slot. */
function registerSample(
  sample: RuleWindow["samples"][number],
  slot: number,
  seen: { ids: Set<string>; slots: Set<number> },
  stepMs: number,
): "conflicting_samples" | "unaligned_window" | undefined {
  if (
    seen.ids.has(sample.id) ||
    (sample.kind !== "signal" && seen.slots.has(slot))
  )
    return "conflicting_samples";
  seen.ids.add(sample.id);
  seen.slots.add(slot);
  if (sample.kind !== "signal" && slot % stepMs !== 0)
    return "unaligned_window";
  return undefined;
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
    const timing = sampleTiming(sample, window.decisionAt);
    if (timing === "retrospective") {
      result.retrospectiveCount++;
      continue;
    }
    if (timing === "late") {
      result.lateCount++;
      continue;
    }
    if (timing === "invalid") {
      result.reason = "invalid_input";
      return result;
    }
    const conflict = registerSample(
      sample,
      slot,
      { ids, slots },
      rule.stepSeconds * 1000,
    );
    if (conflict) {
      result.reason = conflict;
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
