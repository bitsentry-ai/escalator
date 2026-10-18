import type {
  DetectionRule,
  RuleSample,
  RuleWindow,
  RuleWindowReason,
} from "../../contracts/rules.js";

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
  const end = Date.parse(window.decisionAt),
    start = end - rule.windowSeconds * 1000;
  const ids = new Set<string>(),
    slots = new Set<number>();
  for (const sample of window.samples) {
    if (!matches(rule, sample)) {
      result.reason = "scope_mismatch";
      return result;
    }
    const observed = Date.parse(sample.observedAt);
    if (observed <= start || observed > end) continue;
    if (sample.receivedAt === null) {
      result.retrospectiveCount++;
      continue;
    }
    if (Date.parse(sample.receivedAt) > end) {
      result.lateCount++;
      continue;
    }
    // Every visible observation must have one identity and one periodic slot.
    if (
      ids.has(sample.id) ||
      (sample.kind !== "signal" && slots.has(observed))
    ) {
      result.reason = "conflicting_samples";
      return result;
    }
    ids.add(sample.id);
    slots.add(observed);
    if (
      sample.kind !== "signal" &&
      observed % (rule.stepSeconds * 1000) !== 0
    ) {
      result.reason = "unaligned_window";
      return result;
    }
    result.samples.push(sample);
  }
  result.samples.sort(
    (a, b) =>
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return result;
}
