import { z } from "zod";
import {
  workspaceIdSchema,
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { deploymentStartInputSchema } from "./deploy.js";
import { storableText, unicodeMessage } from "./text.js";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const time = utcTimestampSchema.transform((value) =>
  new Date(value).toISOString(),
);
export const deploymentPreflightInputSchema = z.strictObject({
  version: z.literal(1),
  source: deploymentStartInputSchema.shape.source,
  externalId: deploymentStartInputSchema.shape.externalId,
  environmentId: environmentIdSchema,
});
export const deploymentCoverageBindingSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  targetId: opaqueIdSchema,
  targetRevision: revision,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  policyId: opaqueIdSchema,
  source: deploymentStartInputSchema.shape.source,
  externalId: deploymentStartInputSchema.shape.externalId,
  mappedDeployerId: responderIdSchema.nullable(),
});
export const deploymentCoverageEvaluationSchema = z
  .strictObject({
    decision: z.enum(["allow", "block"]),
    reason: z.enum([
      "declared_coverage",
      "no_declared_coverage",
      "unmapped_deployer",
      "configuration_unavailable",
    ]),
    eligibleResponderIds: z.array(responderIdSchema).max(102),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: revision.nullable(),
    scheduleVersions: z
      .array(z.strictObject({ id: opaqueIdSchema, version: revision }))
      .max(2),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.eligibleResponderIds).size !==
        value.eligibleResponderIds.length ||
      new Set(value.scheduleVersions.map((row) => row.id)).size !==
        value.scheduleVersions.length ||
      (value.decision === "allow") !==
        (value.reason === "declared_coverage" &&
          value.eligibleResponderIds.length > 0) ||
      (value.decision === "block" &&
        (value.eligibleResponderIds.length !== 0 ||
          value.reason === "declared_coverage"))
    )
      ctx.addIssue({ code: "custom", message: "Invalid coverage evaluation" });
  });
export const coverageOverrideReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(storableText, unicodeMessage);
export const deploymentCoverageDecisionSchema = z
  .strictObject({
    id: opaqueIdSchema,
    binding: deploymentCoverageBindingSchema,
    evaluation: deploymentCoverageEvaluationSchema,
    evaluatedAt: time,
    expiresAt: time,
    override: z
      .strictObject({
        responderId: responderIdSchema,
        reason: coverageOverrideReasonSchema,
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    const duration =
      Date.parse(value.expiresAt) - Date.parse(value.evaluatedAt);
    if (
      duration <= 0 ||
      duration > 300000 ||
      (value.binding.mappedDeployerId !== null &&
        value.evaluation.eligibleResponderIds.includes(
          value.binding.mappedDeployerId,
        ))
    )
      ctx.addIssue({ code: "custom", message: "Invalid coverage decision" });
  });
export type DeploymentCoverageBinding = z.infer<
  typeof deploymentCoverageBindingSchema
>;
export type DeploymentCoverageEvaluation = z.infer<
  typeof deploymentCoverageEvaluationSchema
>;
export type DeploymentCoverageDecision = z.infer<
  typeof deploymentCoverageDecisionSchema
>;
export type DeploymentPreflightInput = z.infer<
  typeof deploymentPreflightInputSchema
>;
