import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import {
  deploymentTargetSchema,
  deploymentTokenSchema,
} from "./deploy-storage.js";
const target = deploymentTargetSchema.shape;
const grant = deploymentTokenSchema.shape;
const editable = {
  name: target.name,
  enabled: target.enabled,
  policyId: target.policyId,
  timeoutSeconds: target.timeoutSeconds,
};
export const createDeploymentTargetSchema = z.strictObject({
  serviceId: target.serviceId,
  environmentId: target.environmentId,
  ...editable,
  enabled: target.enabled.default(true),
});
export const updateDeploymentTargetSchema = z.strictObject({
  id: target.id,
  expectedRevision: target.revision,
  ...editable,
});
export const deploymentTargetIdSchema = z.strictObject({ targetId: target.id });
export const deploymentPageSchema = z.strictObject({
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const deploymentGrantPageInputSchema = z.strictObject({
  targetId: target.id,
  ...deploymentPageSchema.shape,
});
export const issueDeploymentTokenSchema = z.strictObject({
  targetId: target.id,
  capabilities: grant.capabilities,
  mappedDeployerId: grant.mappedDeployerId.default(null),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 86400)
    .default(30 * 86400),
});
export const revokeDeploymentTokenSchema = z.strictObject({
  targetId: target.id,
  id: grant.id,
});
/** Inventory never returns the bearer secret or its digest. */
export const deploymentGrantSummarySchema = z.strictObject({
  id: grant.id,
  targetId: grant.targetId,
  capabilities: grant.capabilities,
  mappedDeployerId: grant.mappedDeployerId,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt,
});
export type CreateDeploymentTargetInput = z.input<
  typeof createDeploymentTargetSchema
>;
export type UpdateDeploymentTargetInput = z.input<
  typeof updateDeploymentTargetSchema
>;
export type IssueDeploymentTokenInput = z.input<
  typeof issueDeploymentTokenSchema
>;
export type DeploymentGrantSummary = z.infer<
  typeof deploymentGrantSummarySchema
>;
