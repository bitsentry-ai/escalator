import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { detectionRuleSchema } from "./rules.js";
import { detectionRuleVersionSchema } from "./rule-state.js";
import { compareUtcTimestamps } from "./timestamps.js";
export const ruleCandidateParameterKeys = [
  "aggregation",
  "windowSeconds",
  "minimumSamples",
  "trigger",
  "recovery",
  "persistenceSeconds",
  "recoverySeconds",
  "cooldownSeconds",
] as const;
const shape = detectionRuleSchema.shape;
export const ruleCandidateParametersSchema = z.strictObject({
  aggregation: shape.aggregation,
  windowSeconds: shape.windowSeconds,
  minimumSamples: shape.minimumSamples,
  trigger: shape.trigger,
  recovery: shape.recovery,
  persistenceSeconds: shape.persistenceSeconds,
  recoverySeconds: shape.recoverySeconds,
  cooldownSeconds: shape.cooldownSeconds,
});
const total = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const count = total.int();
const timestamp = utcTimestampSchema.max(40);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  }, "Invalid training day");
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Only scalar training evidence crosses the worker boundary. No free text,
 * provider configuration, credentials, raw receipts or held-out diagnostics. */
export const ruleCandidateContextSchema = z
  .strictObject({
    cutoffAt: timestamp,
    coverageVerified: z.literal(false),
    seed: z.strictObject({
      selector: z.strictObject({
        kind: z.enum(["probe", "metric", "signal"]),
        field: z.enum([
          "failure",
          "duration_ms",
          "requests",
          "errors",
          "error_rate",
          "events",
        ]),
      }),
      stepSeconds: shape.stepSeconds,
      collectionDelaySeconds: z.number().int().min(0).max(86400),
      parameters: ruleCandidateParametersSchema,
    }),
    days: z
      .array(
        z.strictObject({
          date: day,
          samples: count.min(1),
          usable: count,
          failures: count,
          durationSum: total,
          durationCount: count,
          requests: total,
          errors: total,
          missingValues: count,
        }),
      )
      .max(33),
    reviewedLabels: z
      .array(
        z.strictObject({
          startedAt: timestamp,
          endedAt: timestamp,
          outcome: z.enum(["actionable", "noise"]),
        }),
      )
      .max(1000),
  })
  .superRefine((context, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (!context.days.length && !context.reviewedLabels.length)
      reject("No training evidence available");
    let previous = "";
    for (const value of context.days) {
      if (value.date <= previous || value.date > context.cutoffAt.slice(0, 10))
        reject("Training days exceed cutoff or are unordered");
      if (
        [
          value.usable,
          value.failures,
          value.durationCount,
          value.missingValues,
        ].some((n) => n > value.samples)
      )
        reject("Invalid training sample counts");
      previous = value.date;
    }
    for (const label of context.reviewedLabels)
      if (
        compareUtcTimestamps(label.startedAt, label.endedAt) >= 0 ||
        compareUtcTimestamps(label.endedAt, context.cutoffAt) > 0
      )
        reject("Training label exceeds cutoff or has an empty interval");
    if (bytes(context) > 131072) reject("Training context exceeds budget");
  });
/** Internal host-prepared message, never accepted as user-provided evidence.
 * The receiving worker must additionally bind this scope/profile to its claim. */
export const ruleCandidateInputSchema = z
  .strictObject({
    version: z.literal(1),
    sourceSnapshotId: opaqueIdSchema,
    sourceInputHash: z.string().regex(/^[a-f0-9]{64}$/),
    seedVersion: detectionRuleVersionSchema,
    profileId: opaqueIdSchema,
    candidateId: opaqueIdSchema,
    context: ruleCandidateContextSchema,
  })
  .superRefine((input, ctx) => {
    const rule = input.seedVersion.definition,
      seed = input.context.seed;
    if (input.candidateId === input.seedVersion.id)
      ctx.addIssue({
        code: "custom",
        message: "Candidate requires a new rule ID",
      });
    if (
      seed.selector.kind !== rule.selector.kind ||
      seed.selector.field !== rule.selector.field ||
      seed.stepSeconds !== rule.stepSeconds ||
      seed.collectionDelaySeconds !== (rule.collectionDelaySeconds ?? 0) ||
      ruleCandidateParameterKeys.some(
        (key) =>
          JSON.stringify(seed.parameters[key]) !== JSON.stringify(rule[key]),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Training seed does not match the captured rule",
      });
    if (bytes(input) > 163840)
      ctx.addIssue({
        code: "custom",
        message: "Prepared candidate input exceeds budget",
      });
  });
export type RuleCandidateInput = z.infer<typeof ruleCandidateInputSchema>;
