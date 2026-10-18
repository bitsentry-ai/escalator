import { z } from "zod";
import {
  providerIntakeSchema,
  providerSourceKind,
  usesProviderSignature,
  needsManualProviderRecovery,
} from "./intake-config.js";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";

import { storableText, unicodeMessage } from "./text.js";

/** Hosts enforce this byte limit while reading, before JSON parsing. */
export const SIGNAL_INGRESS_MAX_BYTES = 256 * 1024;
const externalKey = z
  .string()
  .min(1)
  .max(256)
  .refine(storableText, unicodeMessage)
  .refine(
    (value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Event keys cannot contain control characters",
  );
const attribute = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  value: z.string().max(1000).refine(storableText, unicodeMessage),
});
/** Provider adapters allowlist/redact evidence before constructing this value.
 * No arbitrary provider payload, request headers, credentials or response body.
 */
export const signalEvidenceSchema = z.strictObject({
  summary: z.string().max(4000).refine(storableText, unicodeMessage),
  attributes: z
    .array(attribute)
    .max(16)
    .refine(
      (values) =>
        new Set(values.map((value) => value.name)).size === values.length,
      "Duplicate evidence attribute",
    ),
});
const eventFields = {
  version: z.literal(1),
  eventId: externalKey,
  fingerprint: externalKey,
  // Canonical milliseconds match both adapters and the scheduler's clock.
  observedAt: utcTimestampSchema.transform((value) =>
    new Date(value).toISOString(),
  ),
  status: z.enum(["active", "recovered"]),
  severity: z.enum(["critical", "high", "warning"]),
  title: z.string().trim().min(1).max(500).refine(storableText, unicodeMessage),
  evidence: signalEvidenceSchema,
};
/** Generic machine input has no tenant, service, source or received-time fields.
 * Authentication and the stored source configuration supply that context.
 */
export const signalInputSchema = z.strictObject(eventFields);
export const signalEventSchema = z.strictObject({
  ...eventFields,
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  sourceId: opaqueIdSchema,
  receivedAt: utcTimestampSchema,
});
export const signalSourceKindSchema = z.enum([
  "generic",
  "sentry",
  "glitchtip",
  "grafana",
  "probe",
  "heartbeat",
  "metrics",
]);
export const signalSourceSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(storableText, unicodeMessage),
    kind: signalSourceKindSchema,
    enabled: z.boolean(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    // Both modes retain service/environment boundaries. The second deliberately
    // groups matching fingerprints across sources; never all alerts in a service.
    grouping: z.enum(["source-fingerprint", "fingerprint"]),
    recovery: z.enum(["explicit", "manual"]),
    recoveryHoldSeconds: z.number().int().min(0).max(86_400),
    authSecretId: opaqueIdSchema.nullable(),
    intake: providerIntakeSchema.optional(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (row) =>
      !row.intake ||
      (providerSourceKind(row.intake) === row.kind &&
        usesProviderSignature(row.intake) === (row.authSecretId !== null) &&
        (!needsManualProviderRecovery(row.intake) ||
          row.recovery === "manual")),
    "Provider configuration does not match the source or recovery policy",
  )
  .refine(
    (row) => Date.parse(row.updatedAt) >= Date.parse(row.createdAt),
    "Source update precedes creation",
  );
/** Hash-only grant bound to one source. Revocation/expiry are checked again
 * inside the same database transaction that accepts a signal and queues work.
 */
export const signalTokenSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    sourceId: opaqueIdSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.literal("signal:write"),
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    revokedAt: utcTimestampSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    if (Date.parse(row.expiresAt) <= Date.parse(row.createdAt))
      ctx.addIssue({
        code: "custom",
        message: "Token expiry must follow creation",
      });
    if (
      row.revokedAt !== null &&
      Date.parse(row.revokedAt) < Date.parse(row.createdAt)
    )
      ctx.addIssue({ code: "custom", message: "Revocation precedes creation" });
  });
export type SignalInput = z.infer<typeof signalInputSchema>;
export type SignalEvent = z.infer<typeof signalEventSchema>;
export type SignalSource = z.infer<typeof signalSourceSchema>;
export type SignalToken = z.infer<typeof signalTokenSchema>;
