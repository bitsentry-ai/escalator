import { z } from "zod";
import { metricMonitorSchema } from "./metric-records.js";
import { opaqueIdSchema } from "./identity.js";
const fields = metricMonitorSchema.shape;
const editable = {
  name: fields.name,
  enabled: fields.enabled,
  stepSeconds: fields.stepSeconds,
  query: fields.query,
  rule: fields.rule,
};
export const createMetricSchema = z.strictObject({
  ...editable,
  serviceId: fields.serviceId,
  environmentId: fields.environmentId,
  enabled: fields.enabled.default(false),
});
export const updateMetricSchema = z.strictObject({
  ...editable,
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const metricIdInputSchema = z.strictObject({ id: opaqueIdSchema });
export const disableMetricSchema = z.strictObject({
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const metricPageSchema = z.strictObject({
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const metricHistorySchema = z.strictObject({
  id: opaqueIdSchema,
  ...metricPageSchema.shape,
});
export type CreateMetricInput = z.input<typeof createMetricSchema>;
export type UpdateMetricInput = z.input<typeof updateMetricSchema>;
