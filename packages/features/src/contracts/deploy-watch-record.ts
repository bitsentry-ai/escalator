import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { deploymentWatchVerdictSchema } from "./deploy.js";
import {
  watchCriteriaSchema,
  deploymentWatchSeconds,
  deploymentWatchReceiptGraceSeconds,
  type WatchStreamEvaluation,
} from "./deploy-watch.js";
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rate = z.number().finite().min(0).max(1).nullable();
const coverage = z
  .strictObject({
    coverageVersion: z.literal(1),
    expectedSlots: integer,
    availableSlots: integer,
    gaps: z
      .array(
        z.strictObject({
          startAt: utcTimestampSchema,
          endAt: utcTimestampSchema,
          reason: z.enum([
            "configuration_unknown",
            "configuration_unavailable",
            "disabled",
            "missing",
            "late",
            "retrospective",
            "unusable",
            "query_truncated",
          ]),
        }),
      )
      .max(4096),
    queryComplete: z.boolean(),
  })
  .refine((value) => value.availableSlots <= value.expectedSlots);
const summary = z.strictObject({
  coverage,
  evidence: z
    .array(
      z.strictObject({
        id: opaqueIdSchema,
        version: integer.min(1),
        slotAt: utcTimestampSchema,
        stepSeconds: z.number().int().min(1).max(86400),
      }),
    )
    .max(2000),
  requests: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  errors: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  failedProbes: integer.nullable(),
});
/** Stored results use the evaluator's versioned shape; no provider bodies or secrets. */
export const watchStreamEvaluationSchema: z.ZodType<WatchStreamEvaluation> =
  z.strictObject({
    evaluatorVersion: z.literal(1),
    streamId: opaqueIdSchema,
    criteria: watchCriteriaSchema,
    evaluatedAt: utcTimestampSchema,
    final: z.boolean(),
    verdict: deploymentWatchVerdictSchema,
    reason: z.enum([
      "baseline_coverage",
      "watch_coverage",
      "configuration_changed",
      "insufficient_requests",
      "count_overflow",
      "threshold_met",
      "degraded",
      "baseline_unhealthy",
      "stable",
      "observing",
    ]),
    baseline: summary,
    watch: summary,
    baselineErrorRate: rate,
    watchErrorRate: rate,
    effectiveErrorRateThreshold: rate,
    longestFailureRun: integer.nullable(),
  });
export const evaluatedWatchStreamSchema = z
  .strictObject({
    kind: z.enum(["probe", "metric"]),
    id: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    evaluation: watchStreamEvaluationSchema,
  })
  .refine(
    (value) =>
      value.kind === value.evaluation.criteria.kind &&
      value.id === value.evaluation.streamId,
  );
const deploymentWatchRecordShape = z.strictObject({
  formatVersion: z.literal(1),
  workspaceId: workspaceIdSchema,
  targetId: opaqueIdSchema,
  deploymentId: opaqueIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  revision: integer.min(1),
  startedAt: utcTimestampSchema,
  endsAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  evaluatedAt: utcTimestampSchema.nullable(),
  finalizedAt: utcTimestampSchema.nullable(),
  verdict: deploymentWatchVerdictSchema,
  inventoryComplete: z.boolean(),
  streams: z.array(evaluatedWatchStreamSchema).max(128),
  firstFailure: evaluatedWatchStreamSchema.nullable(),
  incidentId: opaqueIdSchema.nullable(),
  /** Overlap is correlation only. Missing inventory also prevents a certain attribution claim. */
  overlappingDeploymentIds: z.array(opaqueIdSchema).max(128),
  overlapInventoryComplete: z.boolean(),
});
type WatchRecordShape = z.infer<typeof deploymentWatchRecordShape>;
type Invalid = (message: string) => void;
const at = Date.parse;
const graceEnd = (value: WatchRecordShape) =>
  at(value.endsAt) + deploymentWatchReceiptGraceSeconds * 1000;
function checkWatchTimes(value: WatchRecordShape, invalid: Invalid): void {
  if (
    at(value.endsAt) - at(value.startedAt) !== deploymentWatchSeconds * 1000 ||
    at(value.updatedAt) < at(value.startedAt)
  )
    invalid("Invalid watch window");
  if (
    value.evaluatedAt !== null &&
    (at(value.evaluatedAt) < at(value.startedAt) ||
      at(value.evaluatedAt) > at(value.updatedAt))
  )
    invalid("Invalid evaluation time");
  if (
    value.finalizedAt !== null &&
    (value.evaluatedAt === null ||
      at(value.finalizedAt) !== at(value.evaluatedAt) ||
      at(value.finalizedAt) < graceEnd(value) ||
      value.verdict === "PENDING")
  )
    invalid("Invalid finalization");
}
function checkVerdictEvidence(value: WatchRecordShape, invalid: Invalid): void {
  if ((value.verdict === "FAIL") !== (value.firstFailure !== null))
    invalid("Failed watches preserve first evidence");
  if (value.incidentId !== null && value.firstFailure === null)
    invalid("Only failed watches link an incident");
  if (
    value.firstFailure &&
    (value.firstFailure.evaluation.verdict !== "FAIL" ||
      at(value.firstFailure.evaluation.evaluatedAt) > at(value.updatedAt) ||
      at(value.firstFailure.evaluation.evaluatedAt) < at(value.startedAt))
  )
    invalid("Invalid first failure");
  if (
    value.evaluatedAt === null &&
    (value.streams.length !== 0 ||
      value.verdict !== "PENDING" ||
      value.firstFailure !== null)
  )
    invalid("Unevaluated watch contains a verdict");
  if (
    (value.verdict === "PASS" || value.verdict === "WARN") &&
    value.finalizedAt === null
  )
    invalid("Healthy verdict requires a complete watch");
}
function checkStreams(value: WatchRecordShape, invalid: Invalid): void {
  const keys = new Set<string>(),
    sources = new Set<string>();
  for (const stream of value.streams) {
    const key = stream.kind + ":" + stream.id;
    if (keys.has(key) || sources.has(stream.sourceId))
      invalid("Duplicate watch stream");
    keys.add(key);
    sources.add(stream.sourceId);
    if (value.evaluatedAt !== stream.evaluation.evaluatedAt)
      invalid("Mixed evaluation cutoffs");
    if (
      value.evaluatedAt !== null &&
      stream.evaluation.final !== at(value.evaluatedAt) >= graceEnd(value)
    )
      invalid("Mixed finalization cutoffs");
  }
}
export const deploymentWatchRecordSchema =
  deploymentWatchRecordShape.superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    checkWatchTimes(value, invalid);
    checkVerdictEvidence(value, invalid);
    checkStreams(value, invalid);
    if (
      new Set(value.overlappingDeploymentIds).size !==
        value.overlappingDeploymentIds.length ||
      value.overlappingDeploymentIds.includes(value.deploymentId)
    )
      invalid("Invalid overlap inventory");
    if (JSON.stringify(value).length > 2000000)
      invalid("Watch evidence exceeds its storage bound");
  });
export type EvaluatedWatchStream = z.infer<typeof evaluatedWatchStreamSchema>;
export type DeploymentWatchRecord = z.infer<typeof deploymentWatchRecordSchema>;
