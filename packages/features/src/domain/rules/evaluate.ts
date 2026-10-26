import { hasSubmillisecondTime } from "../../contracts/timestamps.js";
import {
  detectionRuleSchema,
  ruleWindowSchema,
  type DetectionRule,
  type RuleWindow,
  type RuleWindowReason,
  type RuleWindowVerdict,
} from "../../contracts/rules.js";
import { selectRuleSamples } from "./window-samples.js";
import { aggregateRuleSamples } from "./aggregate.js";

/** Stateless predicate shared by live execution and replay. It never opens,
 * clears or mutates an incident; the decision state machine owns persistence.
 */
export function evaluateRuleWindow(
  input: DetectionRule,
  snapshot: RuleWindow,
): RuleWindowVerdict {
  const verdict: RuleWindowVerdict = {
    evaluatorVersion: 1,
    state: "insufficient_data",
    reason: "invalid_input",
    value: null,
    sampleCount: 0,
    lateCount: 0,
    retrospectiveCount: 0,
  };
  const unknown = (reason: RuleWindowReason): RuleWindowVerdict => ({
    ...verdict,
    reason,
  });
  const parsedRule = detectionRuleSchema.safeParse(input),
    parsedWindow = ruleWindowSchema.safeParse(snapshot);
  if (!parsedRule.success || !parsedWindow.success) return verdict;
  const rule = parsedRule.data,
    window = parsedWindow.data;
  if (
    hasSubmillisecondTime(window.decisionAt) ||
    Date.parse(window.decisionAt) % (rule.stepSeconds * 1000) !== 0
  )
    return unknown("unaligned_window");
  if (!window.complete) return unknown("incomplete_read");
  if (window.coverage !== "complete")
    return unknown(
      window.coverage === "gaps" ? "coverage_gaps" : "coverage_unknown",
    );
  const selected = selectRuleSamples(rule, window);
  verdict.sampleCount = selected.samples.length;
  verdict.lateCount = selected.lateCount;
  verdict.retrospectiveCount = selected.retrospectiveCount;
  if (selected.reason) return unknown(selected.reason);
  if (selected.retrospectiveCount) return unknown("retrospective_samples");
  if (
    selected.samples.length < rule.minimumSamples ||
    (rule.selector.kind !== "signal" &&
      selected.samples.length !== rule.windowSeconds / rule.stepSeconds)
  )
    return unknown("missing_samples");
  const aggregate = aggregateRuleSamples(rule, selected.samples);
  if (aggregate.reason || aggregate.value === null)
    return unknown(aggregate.reason ?? "unusable_samples");
  verdict.value = aggregate.value;
  const trigger =
    rule.trigger.operator === "gt"
      ? aggregate.value > rule.trigger.value
      : aggregate.value >= rule.trigger.value;
  const recovery =
    rule.recovery.operator === "lt"
      ? aggregate.value < rule.recovery.value
      : aggregate.value <= rule.recovery.value;
  if (trigger) return { ...verdict, state: "trigger", reason: "trigger" };
  if (recovery) return { ...verdict, state: "recovery", reason: "recovery" };
  return { ...verdict, state: "hold", reason: "between_thresholds" };
}
