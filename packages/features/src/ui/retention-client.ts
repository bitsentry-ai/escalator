import type {
  ReplayRetentionPolicy,
  ReplayRetentionSettings,
  UpdateReplayRetention,
  ReplayCoverageQuery,
  ReplayCoverageResult,
} from "../contracts/index.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
export interface RetentionPolicyView {
  configured: ReplayRetentionPolicy | null;
  effective: ReplayRetentionSettings;
  limits: ReplayRetentionSettings;
}
export type CoverageKind = ReplayCoverageQuery["kind"];
export interface RetentionClient {
  get(): Promise<RetentionPolicyView>;
  update(input: UpdateReplayRetention): Promise<RetentionPolicyView>;
  coverage(input: ReplayCoverageQuery): Promise<ReplayCoverageResult>;
  streams(
    kind: CoverageKind,
    input: ProbePageInput,
  ): Promise<ProbeCollection<{ id: string; name: string }>>;
}
