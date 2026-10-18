import {
  deploymentEntrySchema,
  deploymentPagePolicySchema,
  type DeploymentEntry,
} from "../../contracts/index.js";
import { pagingWorkId } from "../paging/work-ids.js";
/** A frozen timeout ladder: deployer now, service fallback after two minutes, then
 * the service's configured bounded reminders/operator notification. No schedule spoofing.
 */
export function stuckDeploymentPolicy(raw: DeploymentEntry) {
  const { deployment, policy } = deploymentEntrySchema.parse(raw);
  return deploymentPagePolicySchema.parse({
    id: pagingWorkId(
      deployment.workspaceId,
      "deploy-timeout-policy",
      deployment.id,
    ),
    workspaceId: deployment.workspaceId,
    serviceId: deployment.serviceId,
    version: 1,
    deployment: {
      id: deployment.id,
      mappedDeployerId: deployment.mappedDeployerId,
      sourcePolicyId: policy.id,
      sourcePolicyVersion: policy.version,
    },
    fallbackResponderIds: policy.fallbackResponderIds,
    steps: [
      { id: "deployer", offsetMs: 0, target: "deployer" },
      { id: "service-fallback", offsetMs: 120000, target: "fallback" },
    ],
    terminal: policy.terminal,
  });
}
