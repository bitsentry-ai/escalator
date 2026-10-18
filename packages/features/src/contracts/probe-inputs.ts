import { z } from "zod";
import { probeSchema } from "./probes.js";
import { opaqueIdSchema } from "./identity.js";
const fields = probeSchema.shape;
const editable = {
  name: fields.name,
  enabled: fields.enabled,
  intervalSeconds: fields.intervalSeconds,
  critical: fields.critical,
  failureThreshold: fields.failureThreshold,
  recoveryThreshold: fields.recoveryThreshold,
  config: fields.config,
};
export const createProbeSchema = z.strictObject({
  ...editable,
  serviceId: fields.serviceId,
  environmentId: fields.environmentId,
  enabled: fields.enabled.default(false),
});
export const updateProbeSchema = z.strictObject({
  ...editable,
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const probeIdInputSchema = z.strictObject({ id: opaqueIdSchema });
export const disableProbeSchema = z.strictObject({
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const probePageSchema = z.strictObject({
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const probeHistorySchema = z.strictObject({
  id: opaqueIdSchema,
  ...probePageSchema.shape,
});
export type CreateProbeInput = z.input<typeof createProbeSchema>;
export type UpdateProbeInput = z.input<typeof updateProbeSchema>;
