import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { escalationPolicySchema } from "./escalation.js";

const scoped = { id: opaqueIdSchema, workspaceId: workspaceIdSchema };
export const operationalIncidentSchema = z
  .strictObject({
    ...scoped,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    title: z.string().trim().min(1).max(500),
    severity: z.enum(["critical", "high", "warning"]),
    openedAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
  })
  .refine(
    (value) =>
      value.resolvedAt === null ||
      Date.parse(value.resolvedAt) >= Date.parse(value.openedAt),
    "Resolution precedes incident",
  );

export const operationalPageSchema = z
  .strictObject({
    ...scoped,
    incidentId: opaqueIdSchema,
    policy: escalationPolicySchema,
    createdAt: utcTimestampSchema,
    state: z.enum(["open", "exhausted", "acknowledged", "resolved"]),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    acknowledgedBy: responderIdSchema.nullable(),
    acknowledgedAt: utcTimestampSchema.nullable(),
    resolvedAt: utcTimestampSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.policy.workspaceId !== value.workspaceId)
      ctx.addIssue({
        code: "custom",
        message: "Policy scope differs",
        path: ["policy"],
      });
    if (
      (value.acknowledgedBy === null) !== (value.acknowledgedAt === null) ||
      (value.state === "acknowledged" && value.acknowledgedBy === null) ||
      (["open", "exhausted"].includes(value.state) &&
        value.acknowledgedBy !== null) ||
      (value.state === "resolved") !== (value.resolvedAt !== null)
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent page lifecycle" });
    if (
      value.acknowledgedAt !== null &&
      value.resolvedAt !== null &&
      Date.parse(value.resolvedAt) < Date.parse(value.acknowledgedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Resolution precedes acknowledgement",
      });
    for (const at of [value.acknowledgedAt, value.resolvedAt])
      if (at !== null && Date.parse(at) < Date.parse(value.createdAt))
        ctx.addIssue({
          code: "custom",
          message: "Page event precedes creation",
        });
  });

/** One immutable resolution per logical ladder step, including uncovered/skipped steps. */
export const pageStepSchema = z
  .strictObject({
    ...scoped,
    pageId: opaqueIdSchema,
    logicalStepId: opaqueIdSchema,
    dueAt: utcTimestampSchema,
    recordedAt: utcTimestampSchema,
    disposition: z.enum(["dispatch", "skipped", "uncovered"]),
    recipientIds: z.array(responderIdSchema).max(100),
  })
  .refine(
    (value) =>
      new Set(value.recipientIds).size === value.recipientIds.length &&
      (value.disposition === "dispatch"
        ? value.recipientIds.length > 0
        : value.recipientIds.length === 0),
    "Invalid step recipients",
  );

/** Contact, channel and opaque secret reference are frozen; credentials stay in the host store. */
export const recipientDeliverySchema = z.strictObject({
  ...scoped,
  pageId: opaqueIdSchema,
  stepId: opaqueIdSchema,
  recipientId: responderIdSchema,
  contactId: opaqueIdSchema,
  /** Frozen opaque credential reference; null reads pre-activation records safely. */
  secretId: opaqueIdSchema.nullable().default(null),
  channel: z.enum(["pushover", "webhook", "ntfy", "slack", "discord", "email"]),
  createdAt: utcTimestampSchema,
});

/** No provider response body, URL, credentials or acknowledgement token belongs here. */
export const deliveryAttemptSchema = z
  .strictObject({
    ...scoped,
    deliveryId: opaqueIdSchema,
    attempt: z.number().int().min(1).max(1000),
    claimToken: opaqueIdSchema,
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema.nullable(),
    outcome: z.enum(["in_flight", "accepted", "failed", "unknown"]),
    providerReceiptId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .nullable(),
    completedAfterAcknowledgement: z.boolean(),
    retryable: z.boolean().default(false),
    failureReason: z
      .enum([
        "invalid_configuration",
        "secret_unavailable",
        "provider_rejected",
      ])
      .nullable()
      .default(null),
  })
  .refine(
    (value) =>
      (value.outcome === "in_flight") === (value.finishedAt === null) &&
      (value.finishedAt === null ||
        Date.parse(value.finishedAt) >= Date.parse(value.startedAt)) &&
      (value.providerReceiptId === null || value.outcome === "accepted") &&
      (!value.completedAfterAcknowledgement || value.finishedAt !== null) &&
      (!value.retryable || ["failed", "unknown"].includes(value.outcome)) &&
      (value.failureReason === null || value.outcome === "failed"),
    "Invalid attempt result",
  );

/** Raw random acknowledgement credentials exist only while constructing a provider request. */
export const acknowledgementGrantSchema = z
  .strictObject({
    ...scoped,
    pageId: opaqueIdSchema,
    recipientId: responderIdSchema,
    attemptId: opaqueIdSchema,
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
  })
  .refine(
    (value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt),
    "Grant must expire after creation",
  );

export type OperationalIncident = z.infer<typeof operationalIncidentSchema>;
export type OperationalPage = z.infer<typeof operationalPageSchema>;
export type PageStep = z.infer<typeof pageStepSchema>;
export type RecipientDelivery = z.infer<typeof recipientDeliverySchema>;
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;
export type AcknowledgementGrant = z.infer<typeof acknowledgementGrantSchema>;
