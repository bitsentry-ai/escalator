import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";

const seconds = z.number().int().min(60).max(86400);
const threshold = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = {
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
};
/** IDs refer to configured streams, never SQL, URLs or provider query text. */
export const detectionRuleSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("metric"),
    streamId: opaqueIdSchema,
    field: z.enum(["requests", "errors", "error_rate"]),
    minimumRequests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal("probe"),
    streamId: opaqueIdSchema,
    field: z.enum(["failure", "duration_ms"]),
  }),
  z.strictObject({
    kind: z.literal("signal"),
    streamId: opaqueIdSchema,
    field: z.literal("events"),
  }),
]);

/** Version 1 detects elevated values with explicit, non-overlapping recovery. */
export const detectionRuleSchema = z
  .strictObject({
    languageVersion: z.literal(1),
    ...scope,
    selector: detectionRuleSelectorSchema,
    aggregation: z.enum(["sum", "mean", "minimum", "maximum", "count"]),
    windowSeconds: seconds,
    stepSeconds: seconds,
    minimumSamples: z.number().int().min(1).max(1440),
    trigger: z.strictObject({
      operator: z.enum(["gt", "gte"]),
      value: threshold,
    }),
    recovery: z.strictObject({
      operator: z.enum(["lt", "lte"]),
      value: threshold,
    }),
    /** Consecutive qualifying decision time; zero fires on the first window. */
    persistenceSeconds: z.number().int().min(0).max(86400),
    recoverySeconds: z.number().int().min(0).max(86400),
    cooldownSeconds: z.number().int().min(0).max(604800),
    severity: z.enum(["critical", "high", "warning"]),
  })
  .superRefine((rule, context) => {
    const reject = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (rule.windowSeconds % rule.stepSeconds !== 0)
      reject("Window must contain whole decision steps");
    if (
      rule.selector.kind !== "signal" &&
      rule.minimumSamples > rule.windowSeconds / rule.stepSeconds
    )
      reject("Minimum samples exceed the periodic window");
    if (
      [
        rule.persistenceSeconds,
        rule.recoverySeconds,
        rule.cooldownSeconds,
      ].some((value) => value % rule.stepSeconds !== 0)
    )
      reject(
        "Persistence, recovery and cooldown must use whole decision steps",
      );
    if (
      rule.recovery.value > rule.trigger.value ||
      (rule.recovery.value === rule.trigger.value &&
        rule.trigger.operator === "gte" &&
        rule.recovery.operator === "lte")
    )
      reject("Recovery must not overlap the trigger");
    if ((rule.selector.kind === "signal") !== (rule.aggregation === "count"))
      reject("Count is reserved for signal events");
    if (
      rule.selector.kind === "metric" &&
      rule.selector.field === "error_rate"
    ) {
      if (rule.aggregation === "sum") reject("Error rates cannot be summed");
      if (rule.trigger.value > 1 || rule.recovery.value > 1)
        reject("Rate thresholds cannot exceed one");
    }
    if (
      rule.selector.kind === "probe" &&
      rule.selector.field === "failure" &&
      rule.aggregation !== "sum" &&
      (rule.trigger.value > 1 || rule.recovery.value > 1)
    )
      reject("Failure proportion thresholds cannot exceed one");
  });
export type DetectionRule = z.infer<typeof detectionRuleSchema>;

const sample = {
  ...scope,
  id: opaqueIdSchema,
  streamId: opaqueIdSchema,
  observedAt: utcTimestampSchema,
  /** Null availability is retrospective and cannot establish a live verdict. */
  receivedAt: utcTimestampSchema.nullable(),
};
const count = z
  .number()
  .finite()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const ruleSampleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...sample,
    kind: z.literal("metric"),
    usable: z.boolean(),
    requests: count,
    errors: count,
  }),
  z.strictObject({
    ...sample,
    kind: z.literal("probe"),
    usable: z.boolean(),
    success: z.boolean().nullable(),
    durationMs: count,
  }),
  z.strictObject({ ...sample, kind: z.literal("signal") }),
]);
export type RuleSample = z.infer<typeof ruleSampleSchema>;

/** Periodic windows use the exact grid (decision-window, decision], UTC epoch aligned.
 * Signal windows use that same half-open interval, but do not infer continuity
 * from silence. A complete read alone does not prove source health.
 */
export const ruleWindowSchema = z.strictObject({
  decisionAt: utcTimestampSchema,
  complete: z.boolean(),
  /** Adapter must prove coverage independently of the returned sample count. */
  coverage: z.enum(["complete", "gaps", "unknown"]),
  samples: z.array(ruleSampleSchema).max(100000),
});
export type RuleWindow = z.infer<typeof ruleWindowSchema>;
export type RuleWindowReason =
  | "trigger"
  | "recovery"
  | "between_thresholds"
  | "invalid_input"
  | "unaligned_window"
  | "incomplete_read"
  | "coverage_unknown"
  | "coverage_gaps"
  | "scope_mismatch"
  | "conflicting_samples"
  | "retrospective_samples"
  | "late_samples"
  | "missing_samples"
  | "unusable_samples"
  | "insufficient_requests";
export interface RuleWindowVerdict {
  evaluatorVersion: 1;
  state: "trigger" | "recovery" | "hold" | "insufficient_data";
  reason: RuleWindowReason;
  value: number | null;
  sampleCount: number;
  lateCount: number;
  retrospectiveCount: number;
}
