import type {
  Deployment,
  DeploymentTarget,
  DeploymentWatchView,
  DeploymentHistoryQuery,
  DeploymentDetailQuery,
  DeploymentCoverageDecision,
} from "../contracts/index.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
/** Host sessions supply scope; no machine bearer is stored in the browser. */
export interface DeploymentsClient {
  targets(input: ProbePageInput): Promise<ProbeCollection<DeploymentTarget>>;
  history(input: DeploymentHistoryQuery): Promise<ProbeCollection<Deployment>>;
  detail(input: DeploymentDetailQuery): Promise<DeploymentWatchView>;
  coverage(input: {
    targetId: string;
    decisionId: string;
  }): Promise<DeploymentCoverageDecision>;
}
