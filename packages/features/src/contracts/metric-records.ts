import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { storableText, unicodeMessage } from "./text.js";
import { metricsQuerySchema, metricsRangeSchema } from "./metrics.js";
import { sustainedFloorRuleSchema } from "./sustained-floor.js";
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const metricMonitorSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    sourceId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(storableText, unicodeMessage),
    enabled: z.boolean(),
    version,
    stepSeconds: z.number().int().min(60).max(3600),
    query: metricsQuerySchema,
    rule: sustainedFloorRuleSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (value) =>
      value.rule.windowSeconds % value.stepSeconds === 0 &&
      value.rule.windowSeconds / value.stepSeconds >=
        value.rule.minimumSamples &&
      Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
  );
export const metricScheduleSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    monitorId: opaqueIdSchema,
    monitorVersion: version,
    jobId: opaqueIdSchema.nullable(),
    dueAt: utcTimestampSchema.nullable(),
    lastObservationId: opaqueIdSchema.nullable(),
  })
  .refine((value) => (value.jobId === null) === (value.dueAt === null));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const metricSampleSchema = z
  .strictObject({
    observedAt: utcTimestampSchema,
    requests: z.number().finite().nullable(),
    errors: z.number().finite().nullable(),
    quality: z.enum([
      "complete",
      "missing",
      "nonfinite",
      "invalid_counts",
      "provider_annotation",
    ]),
  })
  .refine(
    (value) =>
      value.quality !== "complete" ||
      (value.requests !== null &&
        value.errors !== null &&
        value.requests >= 0 &&
        value.requests <= Number.MAX_SAFE_INTEGER &&
        value.errors >= 0 &&
        value.errors <= value.requests),
  );
const provenance = z.strictObject({
  provider: z.enum(["prometheus", "grafana-prometheus"]),
  datasourceUid: z.string().max(40).nullable(),
  requestsQueryHash: hash,
  errorsQueryHash: hash,
  requestsSeriesHash: hash.nullable(),
  errorsSeriesHash: hash.nullable(),
  range: metricsRangeSchema,
});
export const metricObservationInputSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    monitorId: opaqueIdSchema,
    monitorVersion: version,
    observedAt: utcTimestampSchema,
    receivedAt: utcTimestampSchema,
    reason: z.enum([
      "sampled",
      "invalid_response",
      "provider_unavailable",
      "secret_unavailable",
      "destination_denied",
      "cancelled",
      "timeout",
      "invalid_configuration",
      "service_disabled",
      "source_disabled",
      "stale_window",
    ]),
    sample: metricSampleSchema.nullable(),
    provenance: provenance.nullable(),
  })
  .refine((value) =>
    value.reason === "sampled"
      ? value.sample !== null && value.provenance !== null
      : value.sample === null && value.provenance === null,
  );
const verdict = z.strictObject({
  evaluatorVersion: z.literal(1),
  state: z.enum(["active", "clear", "insufficient_data"]),
  reason: z.enum([
    "floor_met",
    "below_floor",
    "invalid_window",
    "missing_samples",
    "unusable_samples",
    "insufficient_requests",
  ]),
  sampleCount: z.number().int().min(0).max(1440),
  requests: z.number().finite().nullable(),
  errors: z.number().finite().nullable(),
  minimumErrorRate: z.number().min(0).max(1).nullable(),
});
export const metricObservationSchema = metricObservationInputSchema.safeExtend({
  evaluation: verdict,
  inputIds: z.array(opaqueIdSchema).max(1440),
});
export type MetricMonitor = z.infer<typeof metricMonitorSchema>;
export type MetricSchedule = z.infer<typeof metricScheduleSchema>;
export type MetricObservationInput = z.infer<
  typeof metricObservationInputSchema
>;
export type MetricObservationRecord = z.infer<typeof metricObservationSchema>;
