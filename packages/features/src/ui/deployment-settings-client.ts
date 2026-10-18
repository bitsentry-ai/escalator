import type {
  DeploymentTarget,
  CreateDeploymentTargetInput,
  UpdateDeploymentTargetInput,
  DeploymentGrantSummary,
  IssueDeploymentTokenInput,
  Responder,
} from "../contracts/index.js";
import type { IncidentsClient } from "./incidents-client.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
/** Bearer plaintext is returned only on issuance, never on inventory reads. */
export interface DeploymentSettingsClient extends Pick<
  IncidentsClient,
  "services" | "environments" | "policies"
> {
  create(input: CreateDeploymentTargetInput): Promise<DeploymentTarget>;
  update(input: UpdateDeploymentTargetInput): Promise<DeploymentTarget>;
  grants(
    input: ProbePageInput & { targetId: string },
  ): Promise<ProbeCollection<DeploymentGrantSummary>>;
  issue(
    input: IssueDeploymentTokenInput,
  ): Promise<DeploymentGrantSummary & { token: string }>;
  revoke(input: { targetId: string; id: string }): Promise<{ revoked: true }>;
  responders(input: ProbePageInput): Promise<ProbeCollection<Responder>>;
}
