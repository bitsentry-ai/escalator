import {
  hasCapability,
  deploymentHistoryQuerySchema,
  deploymentDetailQuerySchema,
  type Actor,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { DeploymentManagementError } from "./management.js";
import type { DeploymentWatchRepository } from "./watch-persistence.js";
import { readDeploymentWatch } from "./watch-read.js";

function authorize(actor: Actor) {
  if (!hasCapability(actor.role, "deployment:read"))
    throw new DeploymentManagementError("forbidden");
}
/** Human read access is derived by the host; archived targets remain inspectable. */
export class DeploymentQueries {
  constructor(private readonly repository: DeploymentWatchRepository) {}
  async history(actor: Actor, raw: unknown) {
    authorize(actor);
    const { targetId, ...page } = deploymentHistoryQuerySchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const target = await tx.targets.get(targetId);
      if (!target) throw new PersistenceError("not_found");
      if (target.id !== targetId || target.workspaceId !== tx.workspaceId)
        throw new PersistenceError("scope_violation");
      const result = await tx.deployments.list(targetId, page);
      return {
        next: result.next,
        items: result.items.map((entry) => {
          const value = entry.deployment;
          if (
            entry.targetId !== targetId ||
            value.workspaceId !== tx.workspaceId ||
            value.serviceId !== target.serviceId ||
            value.environmentId !== target.environmentId
          )
            throw new PersistenceError("scope_violation");
          return value;
        }),
      };
    });
  }
  async detail(actor: Actor, raw: unknown) {
    authorize(actor);
    const { targetId, id } = deploymentDetailQuerySchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const target = await tx.targets.get(targetId);
      if (!target) throw new PersistenceError("not_found");
      if (target.id !== targetId) throw new PersistenceError("scope_violation");
      return readDeploymentWatch(tx, target, id);
    });
  }
}
