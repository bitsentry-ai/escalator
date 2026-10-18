import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import {
  detectionRuleSchema,
  type RuleWindow,
  type RuleWindowVerdict,
} from "./rules.js";

export const detectionRuleVersionSchema = z.strictObject({
  id: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  definition: detectionRuleSchema,
});
export type DetectionRuleVersion = z.infer<typeof detectionRuleVersionSchema>;

/** Stored in the same transaction as incident and outbox changes. A version
 * change requires explicit activation, never silently reusing old state.
 */
export const ruleEvaluationStateSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    ruleId: opaqueIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    evaluatorVersion: z.literal(1),
    lastDecisionAt: utcTimestampSchema,
    activeSince: utcTimestampSchema.nullable(),
    triggerSince: utcTimestampSchema.nullable(),
    recoverySince: utcTimestampSchema.nullable(),
    cooldownUntil: utcTimestampSchema.nullable(),
  })
  .superRefine((state, context) => {
    const reject = (message: string) =>
      context.addIssue({ code: "custom", message });
    const at = Date.parse(state.lastDecisionAt);
    for (const value of [
      state.activeSince,
      state.triggerSince,
      state.recoverySince,
    ])
      if (value !== null && Date.parse(value) > at)
        reject("State timestamps cannot follow the last decision");
    if (state.activeSince === null && state.recoverySince !== null)
      reject("Recovery requires an active episode");
    if (
      state.activeSince !== null &&
      (state.triggerSince !== null || state.cooldownUntil !== null)
    )
      reject("An active episode cannot have a pending trigger or cooldown");
    if (state.triggerSince !== null && state.cooldownUntil !== null)
      reject("A pending trigger cannot accumulate during cooldown");
    if (
      state.activeSince !== null &&
      state.recoverySince !== null &&
      Date.parse(state.recoverySince) < Date.parse(state.activeSince)
    )
      reject("Recovery cannot precede the active episode");
  });
export type RuleEvaluationState = z.infer<typeof ruleEvaluationStateSchema>;

export interface RuleDecisionInput {
  window: RuleWindow;
  /** Trusted effective policy at this decision time, supplied by the host. */
  enabled: boolean;
  maintenance: boolean;
}
export interface RuleTransition {
  state: RuleEvaluationState;
  status: "evaluated" | "suppressed" | "duplicate" | "stale";
  action: "opened" | "recovered" | "none";
  verdict: RuleWindowVerdict | null;
  /** Identifies the start being opened/recovered; never invents a database ID. */
  episodeStartedAt: string | null;
}
