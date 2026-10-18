import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { deploymentSchema } from "./deploy.js";
import { deploymentWatchRecordSchema } from "./deploy-watch-record.js";

/** Persisted verdict and evidence references; never routing or bearer credentials. */
export const deploymentWatchViewSchema = z
  .strictObject({
    targetId: opaqueIdSchema,
    deployment: deploymentSchema,
    watch: deploymentWatchRecordSchema.nullable(),
    baselineAvailable: z.boolean(),
  })
  .refine(
    ({ targetId, deployment, watch }) =>
      watch === null ||
      (watch.targetId === targetId &&
        watch.deploymentId === deployment.id &&
        watch.workspaceId === deployment.workspaceId &&
        watch.serviceId === deployment.serviceId &&
        watch.environmentId === deployment.environmentId),
  );
export type DeploymentWatchView = z.infer<typeof deploymentWatchViewSchema>;
