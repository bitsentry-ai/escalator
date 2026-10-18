import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { deploymentIdempotencyKeySchema } from "./deploy-storage.js";
import {
  deploymentCoverageDecisionSchema,
  deploymentCoverageEvaluationSchema,
  coverageOverrideReasonSchema,
} from "./deploy-coverage.js";
export const deploymentCoverageQuerySchema = z.strictObject({
  targetId: opaqueIdSchema,
  decisionId: opaqueIdSchema,
});
export const overrideDeploymentCoverageSchema =
  deploymentCoverageQuerySchema.extend({
    key: deploymentIdempotencyKeySchema,
    reason: coverageOverrideReasonSchema,
  });
/** The immutable proof is historical; the top-level decision is safe to enforce now. */
export const deploymentPreflightResultSchema = z
  .strictObject({
    decision: z.enum(["allow", "block"]),
    reason: z.enum([
      "declared_coverage",
      "no_declared_coverage",
      "unmapped_deployer",
      "configuration_unavailable",
      "override",
      "expired",
      "stale",
      "override_revoked",
    ]),
    eligibleResponderIds:
      deploymentCoverageEvaluationSchema.shape.eligibleResponderIds,
    proof: deploymentCoverageDecisionSchema,
  })
  .superRefine((value, ctx) => {
    const allowed =
      value.reason === "declared_coverage" || value.reason === "override";
    if (
      new Set(value.eligibleResponderIds).size !==
        value.eligibleResponderIds.length ||
      (value.decision === "allow") !== allowed ||
      (value.decision === "block" && value.eligibleResponderIds.length !== 0) ||
      (value.reason === "declared_coverage" &&
        value.eligibleResponderIds.length === 0) ||
      (value.reason === "override" && value.proof.override === null)
    )
      ctx.addIssue({ code: "custom", message: "Invalid preflight response" });
  });
export type DeploymentPreflightResult = z.infer<
  typeof deploymentPreflightResultSchema
>;
export type OverrideDeploymentCoverageInput = z.infer<
  typeof overrideDeploymentCoverageSchema
>;
