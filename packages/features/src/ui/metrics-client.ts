import type {
  MetricMonitor,
  MetricObservationRecord,
  MetricSchedule,
  CreateMetricInput,
  UpdateMetricInput,
  Service,
  Environment,
} from "../contracts/index.js";
import type { ProbeCollection, ProbePageInput } from "./probes-client.js";
import type { DetectionClient } from "./detection-client.js";
import type { MonitoringSecretsClient } from "./monitoring-client.js";
export interface MetricsClient
  extends DetectionClient, MonitoringSecretsClient {
  list(input: ProbePageInput): Promise<ProbeCollection<MetricMonitor>>;
  get(input: { id: string }): Promise<{
    metric: MetricMonitor;
    schedule: MetricSchedule | null;
    lastObservation: MetricObservationRecord | null;
  }>;
  create(input: CreateMetricInput): Promise<MetricMonitor>;
  update(input: UpdateMetricInput): Promise<MetricMonitor>;
  disable(input: {
    id: string;
    expectedVersion: number;
  }): Promise<MetricMonitor>;
  history(
    input: ProbePageInput & { id: string },
  ): Promise<ProbeCollection<MetricObservationRecord>>;
  services(input: ProbePageInput): Promise<ProbeCollection<Service>>;
  environments(input: ProbePageInput): Promise<ProbeCollection<Environment>>;
}
