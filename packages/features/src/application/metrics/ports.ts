import type { WorkspaceId } from "../../contracts/identity.js";
import type {
  MetricMonitor,
  MetricSchedule,
  MetricObservationInput,
  MetricObservationRecord,
} from "../../contracts/metric-records.js";
import type { Page, PageRequest } from "../ports/persistence.js";
import type { SignalTransaction } from "../signals/ports.js";
export interface MetricWindow {
  monitorId: string;
  monitorVersion: number;
  startAt: string;
  endAt: string;
  visibleAt: string;
  limit: number;
}
export interface MetricsTransaction extends SignalTransaction {
  metrics: {
    lockCapacity(): Promise<void>;
    get(id: string): Promise<MetricMonitor | undefined>;
    /** Source before monitor, then work claim, in all mutation and execution paths. */
    lock(id: string): Promise<MetricMonitor | undefined>;
    list(page: PageRequest): Promise<Page<MetricMonitor>>;
    put(value: MetricMonitor, expectedVersion: number | null): Promise<boolean>;
    version(id: string, version: number): Promise<MetricMonitor | undefined>;
    schedule(id: string): Promise<MetricSchedule | undefined>;
    putSchedule(value: MetricSchedule): Promise<void>;
    observation(id: string): Promise<MetricObservationRecord | undefined>;
    history(
      id: string,
      page: PageRequest,
    ): Promise<Page<MetricObservationRecord>>;
    /** Latest visible receipt per observed timestamp, ordered ascending; retain immutable prior receipts. */
    window(query: MetricWindow): Promise<MetricObservationRecord[]>;
    /** Computes the versioned floor and input receipt IDs inside this physical transaction. */
    observe(input: MetricObservationInput): Promise<MetricObservationRecord>;
  };
}
export interface MetricsRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: MetricsTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface MetricsRecordStore {
  lockCapacity(): Promise<void>;
  get(id: string, lock?: boolean): Promise<MetricMonitor | undefined>;
  list(page: PageRequest): Promise<Page<MetricMonitor>>;
  /** A successful CAS also inserts an immutable configuration-version snapshot. */
  put(value: MetricMonitor, expectedVersion: number | null): Promise<boolean>;
  version(id: string, version: number): Promise<MetricMonitor | undefined>;
  hasSecret(id: string): Promise<boolean>;
  schedule(id: string): Promise<MetricSchedule | undefined>;
  putSchedule(value: MetricSchedule): Promise<void>;
  observation(id: string): Promise<MetricObservationRecord | undefined>;
  history(
    id: string,
    page: PageRequest,
  ): Promise<Page<MetricObservationRecord>>;
  window(query: MetricWindow): Promise<MetricObservationRecord[]>;
  recordObservation(value: MetricObservationRecord): Promise<void>;
}
