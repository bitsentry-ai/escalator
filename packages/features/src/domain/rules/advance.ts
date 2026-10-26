import { hasSubmillisecondTime } from "../../contracts/timestamps.js";
import {
  detectionRuleVersionSchema,
  ruleEvaluationStateSchema,
  type DetectionRuleVersion,
  type RuleEvaluationState,
  type RuleDecisionInput,
  type RuleTransition,
} from "../../contracts/rule-state.js";
import { ruleWindowSchema } from "../../contracts/rules.js";
import { evaluateRuleWindow } from "./evaluate.js";

function result(
  state: RuleEvaluationState,
  status: RuleTransition["status"],
  action: RuleTransition["action"] = "none",
  verdict: RuleTransition["verdict"] = null,
  episodeStartedAt = state.activeSince,
): RuleTransition {
  return {
    state: ruleEvaluationStateSchema.parse(state),
    status,
    action,
    verdict,
    episodeStartedAt,
  };
}

type Rule = DetectionRuleVersion["definition"];
type Verdict = ReturnType<typeof evaluateRuleWindow>;
function assertDecisionInput(
  input: RuleDecisionInput,
  decisionAt: string,
  stepSeconds: number,
): void {
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.maintenance !== "boolean"
  )
    throw new Error("Rule decision requires explicit effective policy");
  if (
    hasSubmillisecondTime(decisionAt) ||
    Date.parse(decisionAt) % (stepSeconds * 1000) !== 0
  )
    throw new Error("Rule decision is not step aligned");
}
/** Stored state must be step aligned and belong to this immutable rule version. */
function assertStoredState(
  previous: RuleEvaluationState,
  version: DetectionRuleVersion,
): void {
  const rule = version.definition;
  if (
    [
      previous.lastDecisionAt,
      previous.activeSince,
      previous.triggerSince,
      previous.recoverySince,
      previous.cooldownUntil,
    ].some(
      (value) =>
        value !== null &&
        (hasSubmillisecondTime(value) ||
          Date.parse(value) % (rule.stepSeconds * 1000) !== 0),
    )
  )
    throw new Error("Stored rule state is not step aligned");
  if (
    previous.ruleId !== version.id ||
    previous.revision !== version.revision ||
    previous.workspaceId !== rule.workspaceId ||
    previous.serviceId !== rule.serviceId ||
    previous.environmentId !== rule.environmentId
  )
    throw new Error("Rule state belongs to another immutable version");
}
function freshState(
  version: DetectionRuleVersion,
  decisionAt: string,
): RuleEvaluationState {
  const rule = version.definition;
  return {
    workspaceId: rule.workspaceId,
    serviceId: rule.serviceId,
    environmentId: rule.environmentId,
    ruleId: version.id,
    revision: version.revision,
    evaluatorVersion: 1,
    lastDecisionAt: decisionAt,
    activeSince: null,
    triggerSince: null,
    recoverySince: null,
    cooldownUntil: null,
  };
}
/** An active episode recovers once recovery verdicts persist for the recovery period. */
function advanceActive(
  state: RuleEvaluationState,
  verdict: Verdict,
  rule: Rule,
  decisionAt: string,
): RuleTransition {
  const at = Date.parse(decisionAt);
  if (verdict.state !== "recovery") {
    state.recoverySince = null;
    return result(state, "evaluated", "none", verdict);
  }
  state.recoverySince ??= decisionAt;
  if (at - Date.parse(state.recoverySince) < rule.recoverySeconds * 1000)
    return result(state, "evaluated", "none", verdict);
  const episode = state.activeSince;
  state.activeSince = null;
  state.recoverySince = null;
  state.cooldownUntil =
    rule.cooldownSeconds === 0
      ? null
      : new Date(at + rule.cooldownSeconds * 1000).toISOString();
  return result(state, "evaluated", "recovered", verdict, episode);
}
/** Outside cooldown, an episode opens once trigger verdicts persist for the persistence period. */
function advanceInactive(
  state: RuleEvaluationState,
  verdict: Verdict,
  rule: Rule,
  decisionAt: string,
): RuleTransition {
  if (verdict.state !== "trigger" || state.cooldownUntil !== null) {
    state.triggerSince = null;
    return result(state, "evaluated", "none", verdict);
  }
  state.triggerSince ??= decisionAt;
  if (
    Date.parse(decisionAt) - Date.parse(state.triggerSince) <
    rule.persistenceSeconds * 1000
  )
    return result(state, "evaluated", "none", verdict);
  state.activeSince = decisionAt;
  state.triggerSince = null;
  return result(state, "evaluated", "opened", verdict);
}
/** Pure restart-safe transition. The host must atomically compare the prior
 * state and commit the returned state with any incident/outbox writes.
 * Acknowledgement of an incident does not reset this detector's episode.
 */
export function advanceRuleDecision(
  versionInput: DetectionRuleVersion,
  previousInput: RuleEvaluationState | null,
  input: RuleDecisionInput,
): RuleTransition {
  const version = detectionRuleVersionSchema.parse(versionInput),
    rule = version.definition;
  const window = ruleWindowSchema.parse(input.window),
    at = Date.parse(window.decisionAt);
  assertDecisionInput(input, window.decisionAt, rule.stepSeconds);
  const previous =
    previousInput === null
      ? null
      : ruleEvaluationStateSchema.parse(previousInput);
  if (previous) assertStoredState(previous, version);
  if (previous && at <= Date.parse(previous.lastDecisionAt))
    return result(
      previous,
      at === Date.parse(previous.lastDecisionAt) ? "duplicate" : "stale",
    );
  const state: RuleEvaluationState = previous
    ? { ...previous, lastDecisionAt: window.decisionAt }
    : freshState(version, window.decisionAt);
  if (
    previous &&
    at - Date.parse(previous.lastDecisionAt) !== rule.stepSeconds * 1000
  ) {
    state.triggerSince = null;
    state.recoverySince = null;
  }
  if (state.cooldownUntil !== null && Date.parse(state.cooldownUntil) <= at)
    state.cooldownUntil = null;
  if (!input.enabled || input.maintenance) {
    state.triggerSince = null;
    state.recoverySince = null;
    return result(state, "suppressed");
  }
  const verdict = evaluateRuleWindow(rule, window);
  return state.activeSince === null
    ? advanceInactive(state, verdict, rule, window.decisionAt)
    : advanceActive(state, verdict, rule, window.decisionAt);
}
