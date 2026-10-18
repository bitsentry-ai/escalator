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
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.maintenance !== "boolean"
  )
    throw new Error("Rule decision requires explicit effective policy");
  if (at % (rule.stepSeconds * 1000) !== 0)
    throw new Error("Rule decision is not step aligned");
  const previous =
    previousInput === null
      ? null
      : ruleEvaluationStateSchema.parse(previousInput);
  if (
    previous &&
    [
      previous.lastDecisionAt,
      previous.activeSince,
      previous.triggerSince,
      previous.recoverySince,
      previous.cooldownUntil,
    ].some(
      (value) =>
        value !== null && Date.parse(value) % (rule.stepSeconds * 1000) !== 0,
    )
  )
    throw new Error("Stored rule state is not step aligned");
  if (
    previous &&
    (previous.ruleId !== version.id ||
      previous.revision !== version.revision ||
      previous.workspaceId !== rule.workspaceId ||
      previous.serviceId !== rule.serviceId ||
      previous.environmentId !== rule.environmentId)
  )
    throw new Error("Rule state belongs to another immutable version");
  if (previous && at <= Date.parse(previous.lastDecisionAt))
    return result(
      previous,
      at === Date.parse(previous.lastDecisionAt) ? "duplicate" : "stale",
    );
  const state: RuleEvaluationState = previous
    ? { ...previous, lastDecisionAt: window.decisionAt }
    : {
        workspaceId: rule.workspaceId,
        serviceId: rule.serviceId,
        environmentId: rule.environmentId,
        ruleId: version.id,
        revision: version.revision,
        evaluatorVersion: 1,
        lastDecisionAt: window.decisionAt,
        activeSince: null,
        triggerSince: null,
        recoverySince: null,
        cooldownUntil: null,
      };
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
  if (state.activeSince !== null) {
    if (verdict.state !== "recovery") state.recoverySince = null;
    else {
      state.recoverySince ??= window.decisionAt;
      if (at - Date.parse(state.recoverySince) >= rule.recoverySeconds * 1000) {
        const episode = state.activeSince;
        state.activeSince = null;
        state.recoverySince = null;
        state.cooldownUntil =
          rule.cooldownSeconds === 0
            ? null
            : new Date(at + rule.cooldownSeconds * 1000).toISOString();
        return result(state, "evaluated", "recovered", verdict, episode);
      }
    }
  } else if (verdict.state === "trigger" && state.cooldownUntil === null) {
    state.triggerSince ??= window.decisionAt;
    if (at - Date.parse(state.triggerSince) >= rule.persistenceSeconds * 1000) {
      state.activeSince = window.decisionAt;
      state.triggerSince = null;
      return result(state, "evaluated", "opened", verdict);
    }
  } else state.triggerSince = null;
  return result(state, "evaluated", "none", verdict);
}
