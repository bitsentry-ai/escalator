import {
  deploymentPageSchema,
  deploymentTargetIdSchema,
  createDeploymentTargetSchema,
  updateDeploymentTargetSchema,
  deploymentGrantPageInputSchema,
  issueDeploymentTokenSchema,
  revokeDeploymentTokenSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
import { deploymentRequest } from "./request.js";
export const deploymentsRouter = t.router({
  list: authenticated
    .input(deploymentPageSchema)
    .query(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(deploymentTargetIdSchema)
    .query(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.get(ctx.actor, input)),
    ),
  create: authenticated
    .input(createDeploymentTargetSchema)
    .mutation(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.create(ctx.actor, input)),
    ),
  update: authenticated
    .input(updateDeploymentTargetSchema)
    .mutation(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.update(ctx.actor, input)),
    ),
  grants: authenticated
    .input(deploymentGrantPageInputSchema)
    .query(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.listTokens(ctx.actor, input)),
    ),
  issueGrant: authenticated
    .input(issueDeploymentTokenSchema)
    .mutation(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.issueToken(ctx.actor, input)),
    ),
  revokeGrant: authenticated
    .input(revokeDeploymentTokenSchema)
    .mutation(({ ctx, input }) =>
      deploymentRequest(() => ctx.deployments.revokeToken(ctx.actor, input)),
    ),
});
