import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { storableText, unicodeMessage } from "./text.js";
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const heartbeatSchema = z
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
    intervalSeconds: z.number().int().min(60).max(86400),
    graceSeconds: z.number().int().min(0).max(3600),
    version,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
  );
export const heartbeatStateSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    probeId: opaqueIdSchema,
    configurationVersion: version,
    generation: version,
    lastAcceptedAt: utcTimestampSchema.nullable(),
    lastObservedAt: utcTimestampSchema.nullable(),
    deadlineAt: utcTimestampSchema.nullable(),
    deadlineJobId: opaqueIdSchema.nullable(),
    missedAt: utcTimestampSchema.nullable(),
  })
  .refine(
    (value) => (value.deadlineAt === null) === (value.deadlineJobId === null),
  )
  .refine(
    (value) =>
      (value.lastAcceptedAt === null) === (value.lastObservedAt === null),
  )
  .refine(
    (value) =>
      !value.lastAcceptedAt ||
      !value.deadlineAt ||
      Date.parse(value.deadlineAt) >= Date.parse(value.lastAcceptedAt),
  );
export const heartbeatPingSchema = z.strictObject({
  version: z.literal(1),
  eventId: opaqueIdSchema,
  observedAt: utcTimestampSchema.transform((value) =>
    new Date(value).toISOString(),
  ),
});
export const heartbeatReceiptSchema = z.strictObject({
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  probeId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  grantId: opaqueIdSchema,
  observedAt: utcTimestampSchema.transform((value) =>
    new Date(value).toISOString(),
  ),
  acceptedAt: utcTimestampSchema,
  generation: version,
  deadlineAt: utcTimestampSchema,
});
export const heartbeatGrantSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    probeId: opaqueIdSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.literal("heartbeat:write"),
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    revokedAt: utcTimestampSchema.nullable(),
  })
  .refine(
    (value) =>
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) <=
        90 * 86400000,
  )
  .refine(
    (value) =>
      value.revokedAt === null ||
      Date.parse(value.revokedAt) >= Date.parse(value.createdAt),
  );
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type HeartbeatState = z.infer<typeof heartbeatStateSchema>;
export type HeartbeatPing = z.infer<typeof heartbeatPingSchema>;
export type HeartbeatReceipt = z.infer<typeof heartbeatReceiptSchema>;
export type HeartbeatGrant = z.infer<typeof heartbeatGrantSchema>;
