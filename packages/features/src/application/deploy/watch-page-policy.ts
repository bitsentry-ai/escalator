import {
  deploymentEntrySchema,
  deploymentWatchRecordSchema,
  deploymentWatchPagePolicySchema,
  type DeploymentEntry,
  type DeploymentWatchRecord,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
/** Scope and lifecycle inputs come from the same locked deployment transaction. */
export function watchPagePolicy(
  rawEntry: DeploymentEntry,
  rawWatch: DeploymentWatchRecord,
) {
  const entry = deploymentEntrySchema.parse(rawEntry),
    watch = deploymentWatchRecordSchema.parse(rawWatch),
    deployment = entry.deployment;
  if (
    watch.workspaceId !== deployment.workspaceId ||
    watch.targetId !== entry.targetId ||
    watch.deploymentId !== deployment.id ||
    watch.serviceId !== deployment.serviceId ||
    watch.environmentId !== deployment.environmentId
  )
    throw new PersistenceError("scope_violation");
  if (!deployment.finish || deployment.finish.receivedAt !== watch.startedAt)
    throw new RangeError("Watch does not match accepted finish");
  if (watch.verdict !== "FAIL" || watch.firstFailure === null)
    throw new RangeError("Only a failed watch can create a page");
  return deploymentWatchPagePolicySchema.parse({
    ...entry.policy,
    watch: { targetId: entry.targetId, deploymentId: deployment.id },
  });
}
