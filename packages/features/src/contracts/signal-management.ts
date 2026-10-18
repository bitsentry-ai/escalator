import { z } from "zod";
import { signalSourceSchema } from "./signal.js";
import { opaqueIdSchema } from "./identity.js";

const source = signalSourceSchema.shape;
export const createSignalSourceSchema = z.strictObject({
  name: source.name,
  serviceId: source.serviceId,
  environmentId: source.environmentId,
  // Additional kinds are enabled by their own provider configuration adapters.
  kind: z.literal("generic"),
  grouping: source.grouping.default("source-fingerprint"),
  recovery: source.recovery.default("explicit"),
  recoveryHoldSeconds: source.recoveryHoldSeconds.default(60),
});
export const updateSignalSourceSchema = z.strictObject({
  id: opaqueIdSchema,
  expectedVersion: source.version,
  name: source.name,
  enabled: source.enabled,
  grouping: source.grouping,
  recovery: source.recovery,
  recoveryHoldSeconds: source.recoveryHoldSeconds,
});
export const signalSourceIdSchema = z.strictObject({ id: opaqueIdSchema });
export const signalSourcePageSchema = z.strictObject({
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const issueSignalTokenSchema = z.strictObject({
  sourceId: opaqueIdSchema,
  // Explicitly expiring grants; rotate by issuing another before revoking the old one.
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 86400)
    .default(30 * 86400),
});
export type CreateSignalSourceInput = z.input<typeof createSignalSourceSchema>;
export type UpdateSignalSourceInput = z.input<typeof updateSignalSourceSchema>;
export type IssueSignalTokenInput = z.input<typeof issueSignalTokenSchema>;
