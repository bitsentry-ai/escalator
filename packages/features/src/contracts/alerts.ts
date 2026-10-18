import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { signalEventSchema } from "./signal.js";
/** One source/fingerprint watermark, retained across incident resolutions. */
export const alertStateSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    sourceId: opaqueIdSchema,
    fingerprint: signalEventSchema.shape.fingerprint,
    groupKey: opaqueIdSchema,
    sourceVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    lastSignalId: opaqueIdSchema,
    observedAt: utcTimestampSchema,
    receivedAt: utcTimestampSchema,
    active: z.boolean(),
    recoveredAt: utcTimestampSchema.nullable(),
    recoveryHoldSeconds: z.number().int().min(0).max(86400),
    incidentId: opaqueIdSchema.nullable(),
  })
  .refine(
    (value) => value.active === (value.recoveredAt === null),
    "Inconsistent alert recovery",
  );
export type AlertState = z.infer<typeof alertStateSchema>;

/** Explicit automatic paging selection; never infer a policy from list order. */
export const serviceEnvironmentSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    policyId: opaqueIdSchema.nullable(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (value) =>
      (!value.enabled || value.policyId !== null) &&
      Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
    "Invalid automatic paging binding",
  );
export type ServiceEnvironment = z.infer<typeof serviceEnvironmentSchema>;
export const alertGroupSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    incidentId: opaqueIdSchema.nullable(),
    recoveryJobId: opaqueIdSchema.nullable(),
  })
  .refine(
    (value) => value.recoveryJobId === null || value.incidentId !== null,
    "Recovery requires an incident",
  );
export type AlertGroup = z.infer<typeof alertGroupSchema>;
export const processedSignalSchema = z.strictObject({
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  sourceId: opaqueIdSchema,
  incidentId: opaqueIdSchema.nullable(),
  disposition: z.enum([
    "active",
    "recovered",
    "stale",
    "duplicate",
    "disabled",
    "future",
    "manual_recovery",
    "manually_resolved",
  ]),
  recordedAt: utcTimestampSchema,
});
export type ProcessedSignal = z.infer<typeof processedSignalSchema>;
