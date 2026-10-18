import { z } from "zod";
import { heartbeatSchema } from "./heartbeat.js";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const fields = heartbeatSchema.shape;
const editable = {
  name: fields.name,
  enabled: fields.enabled,
  intervalSeconds: fields.intervalSeconds,
  graceSeconds: fields.graceSeconds,
};
export const createHeartbeatSchema = z.strictObject({
  ...editable,
  serviceId: fields.serviceId,
  environmentId: fields.environmentId,
  enabled: fields.enabled.default(false),
  intervalSeconds: fields.intervalSeconds.default(60),
  graceSeconds: fields.graceSeconds.default(10),
});
export const updateHeartbeatSchema = z.strictObject({
  ...editable,
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const heartbeatIdSchema = z.strictObject({ id: opaqueIdSchema });
export const heartbeatPageSchema = z.strictObject({
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const disableHeartbeatSchema = z.strictObject({
  id: opaqueIdSchema,
  expectedVersion: fields.version,
});
export const issueHeartbeatGrantSchema = z.strictObject({
  id: opaqueIdSchema,
  expiresAt: utcTimestampSchema,
});
export const revokeHeartbeatGrantSchema = z.strictObject({
  id: opaqueIdSchema,
  grantId: opaqueIdSchema,
});
export type CreateHeartbeatInput = z.input<typeof createHeartbeatSchema>;
export type UpdateHeartbeatInput = z.input<typeof updateHeartbeatSchema>;

export const heartbeatGrantPageSchema = heartbeatPageSchema.extend({
  id: opaqueIdSchema,
});
