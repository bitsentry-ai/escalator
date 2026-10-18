import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { storableText, unicodeMessage } from "./text.js";
import { deploymentSchema, deploymentStatusSchema } from "./deploy.js";
import { escalationPolicySchema } from "./escalation.js";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const time = utcTimestampSchema.transform((value) =>
  new Date(value).toISOString(),
);
export const deploymentTargetSchema = z
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
    enabled: z.boolean(),
    revision,
    timeoutSeconds: z.number().int().min(60).max(86400),
    policyId: opaqueIdSchema,
    createdAt: time,
    updatedAt: time,
  })
  .refine(
    (value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
    "Target update precedes creation",
  );
export const deploymentTokenSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    targetId: opaqueIdSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z
      .array(z.enum(["deployment:read", "deployment:write"]))
      .min(1)
      .max(2)
      .refine(
        (values) => new Set(values).size === values.length,
        "Duplicate capability",
      ),
    mappedDeployerId: responderIdSchema.nullable(),
    createdAt: time,
    expiresAt: time,
    revokedAt: time.nullable(),
  })
  .refine(
    (value) =>
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      (value.revokedAt === null ||
        Date.parse(value.revokedAt) >= Date.parse(value.createdAt)),
    "Invalid grant chronology",
  );
export const deploymentEntrySchema = z
  .strictObject({
    targetId: opaqueIdSchema,
    deployment: deploymentSchema,
    policy: escalationPolicySchema,
  })
  .refine(
    (value) =>
      value.policy.workspaceId === value.deployment.workspaceId &&
      value.policy.serviceId === value.deployment.serviceId,
    "Routing scope differs",
  );
export const deploymentIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const deploymentReceiptResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.enum(["accepted", "duplicate"]),
    deploymentId: opaqueIdSchema,
    revision,
    status: deploymentStatusSchema,
    coverageDecisionId: opaqueIdSchema.optional(),
  }),
  z.strictObject({
    state: z.literal("rejected"),
    deploymentId: opaqueIdSchema.nullable(),
    reason: z.enum([
      "scope",
      "identity",
      "conflict",
      "missing_start",
      "chronology",
    ]),
  }),
]);
/** Immutable result of an authorized command, not an authorization bypass on replay.
 * Raw tokens and raw machine request bodies never enter the receipt.
 */
export const deploymentReceiptSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  targetId: opaqueIdSchema,
  key: deploymentIdempotencyKeySchema,
  action: z.enum(["start", "finish"]),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenId: opaqueIdSchema,
  recordedAt: time,
  result: deploymentReceiptResultSchema,
});
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;
export type DeploymentToken = z.infer<typeof deploymentTokenSchema>;
export type DeploymentEntry = z.infer<typeof deploymentEntrySchema>;
export type DeploymentReceipt = z.infer<typeof deploymentReceiptSchema>;
