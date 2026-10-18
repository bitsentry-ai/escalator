import { z } from "zod";
import { utcTimestampSchema } from "./entities.js";
import {
  periodicCoverageInputSchema,
  type PeriodicCoverageReport,
} from "./replay-coverage.js";
import type { DeploymentWatchVerdict } from "./deploy.js";

export const deploymentBaselineSeconds = 900;
export const deploymentWatchSeconds = 1800;
export const deploymentWatchReceiptGraceSeconds = 120;
const minimumSamples = z.number().int().min(1).max(60);
export const watchCriteriaSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("probe"),
    baselineMinimumSamples: minimumSamples,
    failureThreshold: z.number().int().min(1).max(10),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("metric"),
    baselineMinimumSamples: minimumSamples,
    watchMinimumSamples: minimumSamples,
    minimumRequests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    errorRateFloor: z.number().gt(0).max(1),
    relativeMultiplier: z.number().min(1).max(100),
    absoluteIncrease: z.number().gt(0).max(1),
  }),
]);
export type WatchCriteria = z.infer<typeof watchCriteriaSchema>;
const count = z
  .number()
  .finite()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const reading = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("probe"),
    state: z.enum(["healthy", "failed", "unknown"]),
  }),
  z
    .strictObject({
      kind: z.literal("metric"),
      quality: z.enum(["complete", "unusable"]),
      requests: count,
      errors: count,
    })
    .refine(
      (value) =>
        value.quality !== "complete" ||
        (value.requests !== null &&
          value.errors !== null &&
          value.errors <= value.requests),
    ),
]);
/** Host readers supply bounded, scoped projections of actual immutable observations.
 * configurationCompatible checks the captured measurement definition, not just cadence.
 */
export const watchEvidenceWindowSchema = periodicCoverageInputSchema.extend({
  segments: periodicCoverageInputSchema.shape.segments.max(128),
  samples: z
    .array(
      periodicCoverageInputSchema.shape.samples.element.extend({ reading }),
    )
    .max(2000),
  configurationCompatible: z.boolean(),
});
export const watchStreamEvidenceSchema = z.strictObject({
  deploymentStartedAt: utcTimestampSchema,
  watchEndsAt: utcTimestampSchema,
  evaluatedAt: utcTimestampSchema,
  criteria: watchCriteriaSchema,
  baseline: watchEvidenceWindowSchema,
  watch: watchEvidenceWindowSchema,
});
export type WatchEvidenceWindow = z.infer<typeof watchEvidenceWindowSchema>;
export type WatchStreamEvidence = z.infer<typeof watchStreamEvidenceSchema>;
export interface WatchEvidenceReference {
  id: string;
  version: number;
  slotAt: string;
  stepSeconds: number;
}
export interface WatchEvidenceSummary {
  coverage: PeriodicCoverageReport;
  evidence: WatchEvidenceReference[];
  requests: number | null;
  errors: number | null;
  failedProbes: number | null;
}
export interface WatchStreamEvaluation {
  evaluatorVersion: 1;
  streamId: string;
  criteria: WatchCriteria;
  evaluatedAt: string;
  /** Final requires the entire watch and its bounded receipt grace period. */
  final: boolean;
  verdict: DeploymentWatchVerdict;
  reason:
    | "baseline_coverage"
    | "watch_coverage"
    | "configuration_changed"
    | "insufficient_requests"
    | "count_overflow"
    | "threshold_met"
    | "degraded"
    | "baseline_unhealthy"
    | "stable"
    | "observing";
  baseline: WatchEvidenceSummary;
  watch: WatchEvidenceSummary;
  baselineErrorRate: number | null;
  watchErrorRate: number | null;
  effectiveErrorRateThreshold: number | null;
  longestFailureRun: number | null;
}
