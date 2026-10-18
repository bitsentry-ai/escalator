import { hasSubmillisecondTime } from "./timestamps.js";
import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import {
  detectionRuleVersionSchema,
  ruleEvaluationStateSchema,
} from "./rule-state.js";
import { ruleMeasurementHashSchema } from "./rule-history.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Generation is an activation epoch, separate from the immutable content revision.
 * State cannot survive a rollback/re-activation without a new explicit generation.
 */
export const ruleLiveRecordSchema = z
  .strictObject({
    version: detectionRuleVersionSchema,
    generation: revision,
    revision,
    mode: z.enum(["shadow", "active"]),
    title: z.string().trim().min(1).max(240),
    measurementHash: ruleMeasurementHashSchema,
    state: ruleEvaluationStateSchema.nullable(),
    incidentId: opaqueIdSchema.nullable(),
    dueAt: utcTimestampSchema,
    jobId: opaqueIdSchema,
  })
  .superRefine((row, context) => {
    const { definition, id, revision } = row.version;
    if (
      hasSubmillisecondTime(row.dueAt) ||
      Date.parse(row.dueAt) % (definition.stepSeconds * 1000) !== 0
    )
      context.addIssue({
        code: "custom",
        message: "Rule deadline must be step aligned",
      });
    if (
      row.state &&
      (row.state.ruleId !== id ||
        row.state.revision !== revision ||
        row.state.workspaceId !== definition.workspaceId ||
        row.state.serviceId !== definition.serviceId ||
        row.state.environmentId !== definition.environmentId ||
        Date.parse(row.state.lastDecisionAt) >= Date.parse(row.dueAt))
    )
      context.addIssue({
        code: "custom",
        message: "Rule runtime state does not match the scheduled revision",
      });
    if (
      (row.incidentId !== null &&
        (row.mode !== "active" || row.state?.activeSince == null)) ||
      (row.mode === "active" &&
        row.state?.activeSince != null &&
        row.incidentId === null)
    )
      context.addIssue({
        code: "custom",
        message: "Incident link requires an active rule episode",
      });
  });
export type RuleLiveRecord = z.infer<typeof ruleLiveRecordSchema>;
export const ruleDecisionPolicySchema = z.strictObject({
  known: z.boolean(),
  enabled: z.boolean(),
  maintenance: z.boolean(),
});
export const ruleEvaluationPayloadSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  generation: revision,
  dueAt: utcTimestampSchema,
});
