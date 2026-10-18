import type {
  Heartbeat,
  HeartbeatState,
  HeartbeatGrant,
  CreateHeartbeatInput,
  UpdateHeartbeatInput,
  Service,
  Environment,
} from "../contracts/index.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
import type { DetectionClient } from "./detection-client.js";
export interface HeartbeatsClient extends DetectionClient {
  list(input: ProbePageInput): Promise<ProbeCollection<Heartbeat>>;
  get(input: {
    id: string;
  }): Promise<{ probe: Heartbeat; state: HeartbeatState | null }>;
  create(input: CreateHeartbeatInput): Promise<Heartbeat>;
  update(input: UpdateHeartbeatInput): Promise<Heartbeat>;
  disable(input: { id: string; expectedVersion: number }): Promise<Heartbeat>;
  grants(
    input: ProbePageInput & { id: string },
  ): Promise<
    ProbeCollection<Omit<HeartbeatGrant, "workspaceId" | "tokenHash">>
  >;
  issueGrant(input: {
    id: string;
    expiresAt: string;
  }): Promise<{ id: string; token: string; expiresAt: string }>;
  revokeGrant(input: {
    id: string;
    grantId: string;
  }): Promise<{ revoked: boolean }>;
  services(input: ProbePageInput): Promise<ProbeCollection<Service>>;
  environments(input: ProbePageInput): Promise<ProbeCollection<Environment>>;
}
