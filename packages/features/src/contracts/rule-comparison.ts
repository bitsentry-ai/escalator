import { z } from "zod";
import { detectionRuleVersionSchema } from "./rule-state.js";
import { utcTimestampSchema } from "./entities.js";
const count = z.number().int().min(0).max(44641);
export const ruleBaselineObservationSchema = z
  .strictObject({
    version: detectionRuleVersionSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(["active", "shadow"]),
    decisions: count.min(1),
    evaluated: count,
    suppressed: count,
    unknown: count,
    opened: count,
    recovered: count,
    firstObservedDecisionAt: utcTimestampSchema,
    lastObservedDecisionAt: utcTimestampSchema,
  })
  .refine(
    (r) =>
      r.decisions === r.evaluated + r.suppressed + r.unknown &&
      r.opened + r.recovered <= r.evaluated,
    "Invalid observed rule counts",
  );
export const ruleBaselineCaptureSchema = z.strictObject({
  basis: z.literal("recorded_rule_decisions"),
  visibleAt: utcTimestampSchema,
  firstDecisionAt: utcTimestampSchema,
  lastDecisionAt: utcTimestampSchema,
  complete: z.boolean(),
  legacyUnknown: z.boolean(),
  groups: z.array(ruleBaselineObservationSchema).max(1000),
});
export type RuleBaselineCapture = z.infer<typeof ruleBaselineCaptureSchema>;
export const ruleComparisonSchema = z.strictObject({
  basis: z.literal("recorded_rule_decisions"),
  status: z.enum(["available", "partial", "no_recorded_comparison"]),
  captureComplete: z.boolean(),
  legacyUnknown: z.boolean(),
  candidatePredictedOpenings: count,
  candidateEvaluatedDecisions: count,
  groups: z
    .array(
      z.strictObject({
        observation: ruleBaselineObservationSchema,
        expectedDecisions: count,
        coverage: z.number().min(0).max(1),
        missingDecisions: count,
      }),
    )
    .max(1000),
});
export type RuleComparison = z.infer<typeof ruleComparisonSchema>;
