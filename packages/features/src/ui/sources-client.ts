import type { DetectionClient } from "./detection-client.js";
import type {
  SignalSource,
  SignalGrantSummary,
  CreateSignalSourceInput,
  UpdateSignalSourceInput,
  CreateProviderSourceInput,
  UpdateProviderSourceInput,
  IssueSignalTokenInput,
  Service,
  Environment,
} from "../contracts/index.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
import type { MonitoringSecretsClient } from "./monitoring-client.js";
export interface SourcesClient
  extends MonitoringSecretsClient, DetectionClient {
  list(input: ProbePageInput): Promise<ProbeCollection<SignalSource>>;
  create(input: CreateSignalSourceInput): Promise<SignalSource>;
  update(input: UpdateSignalSourceInput): Promise<SignalSource>;
  createProvider(input: CreateProviderSourceInput): Promise<SignalSource>;
  updateProvider(input: UpdateProviderSourceInput): Promise<SignalSource>;
  grants(
    input: ProbePageInput & { sourceId: string },
  ): Promise<ProbeCollection<SignalGrantSummary>>;
  issueToken(
    input: IssueSignalTokenInput,
  ): Promise<{
    id: string;
    sourceId: string;
    expiresAt: string;
    token: string;
  }>;
  issueReceiver(
    input: IssueSignalTokenInput,
  ): Promise<{
    id: string;
    sourceId: string;
    expiresAt: string;
    receiverId: string;
  }>;
  revoke(input: { id: string }): Promise<{ revoked: true }>;
  services(input: ProbePageInput): Promise<ProbeCollection<Service>>;
  environments(input: ProbePageInput): Promise<ProbeCollection<Environment>>;
}
