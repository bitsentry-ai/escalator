import {
  deploymentWatchViewSchema,
  opaqueIdSchema,
  type DeploymentWatchView,
  type DeploymentTarget,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { DeploymentAccess } from "./access.js";
import type { DeploymentWatchTransaction } from "./watch-persistence.js";

export class DeploymentWatchReader {
  constructor(
    private readonly access: DeploymentAccess<DeploymentWatchTransaction>,
  ) {}
  read(token: string, id: string): Promise<DeploymentWatchView> {
    opaqueIdSchema.parse(id);
    return this.access.run(token, "deployment:read", async ({ tx, target }) => {
      return readDeploymentWatch(tx, target, id);
    });
  }
}

/** Shared scoped projection for machine grants and host-authenticated readers. */
export async function readDeploymentWatch(
  tx: DeploymentWatchTransaction,
  target: DeploymentTarget,
  id: string,
): Promise<DeploymentWatchView> {
  opaqueIdSchema.parse(id);
  if (target.workspaceId !== tx.workspaceId)
    throw new PersistenceError("scope_violation");
  const entry = await tx.deployments.get(target.id, id);
  if (!entry) throw new PersistenceError("not_found");
  const deployment = entry.deployment;
  if (
    entry.targetId !== target.id ||
    deployment.id !== id ||
    deployment.workspaceId !== tx.workspaceId ||
    deployment.serviceId !== target.serviceId ||
    deployment.environmentId !== target.environmentId
  )
    throw new PersistenceError("scope_violation");
  return deploymentWatchViewSchema.parse({
    targetId: target.id,
    deployment,
    watch: (await tx.watches.get(target.id, id)) ?? null,
    baselineAvailable: (await tx.baselines.get(target.id, id)) !== undefined,
  });
}
