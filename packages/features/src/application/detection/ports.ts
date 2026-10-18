import type {
  AlertGroup,
  AlertState,
  ProcessedSignal,
  ServiceEnvironment,
} from "../../contracts/alerts.js";
import type { WorkspaceId } from "../../contracts/index.js";
import type { ConfigurationTransaction } from "../configuration/ports.js";
import type { SignalTransaction } from "../signals/ports.js";
import type { Page, PageRequest } from "../ports/persistence.js";

export interface DetectionTransaction
  extends ConfigurationTransaction, SignalTransaction {
  detection: {
    /** Natural key is (workspace, service, environment); every lookup is scoped. */
    binding(
      serviceId: string,
      environmentId: string,
    ): Promise<ServiceEnvironment | undefined>;
    bindings(page: PageRequest): Promise<Page<ServiceEnvironment>>;
    putBinding(
      value: ServiceEnvironment,
      expectedVersion: number | null,
    ): Promise<boolean>;
    /** Serialize first creation as well as existing groups. Lock order: source, group, page, work claim. */
    lockGroup(key: string): Promise<AlertGroup | undefined>;
    putGroup(
      group: AlertGroup,
      expectedRevision: number | null,
    ): Promise<boolean>;
    alert(id: string): Promise<AlertState | undefined>;
    /** Caller holds owning group lock; an existing active incident link cannot be silently moved. */
    putAlert(value: AlertState): Promise<void>;
    forIncident(
      incidentId: string,
      page: PageRequest,
    ): Promise<Page<AlertState>>;
    processed(signalId: string): Promise<ProcessedSignal | undefined>;
    /** Immutable processing receipt; commits with alert/page/jobs/audit, not lease completion. */
    recordProcessed(value: ProcessedSignal): Promise<void>;
  };
}
export interface DetectionRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: DetectionTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Same physical transaction as signal, paging and configuration primitives. */
export interface DetectionRecordStore {
  binding(
    serviceId: string,
    environmentId: string,
    lock?: boolean,
  ): Promise<ServiceEnvironment | undefined>;
  bindings(page: PageRequest): Promise<Page<ServiceEnvironment>>;
  putBinding(
    value: ServiceEnvironment,
    expectedVersion: number | null,
  ): Promise<boolean>;
  lockGroup(key: string): Promise<AlertGroup | undefined>;
  putGroup(
    group: AlertGroup,
    expectedRevision: number | null,
  ): Promise<boolean>;
  alert(id: string): Promise<AlertState | undefined>;
  putAlert(value: AlertState): Promise<void>;
  forIncident(incidentId: string, page: PageRequest): Promise<Page<AlertState>>;
  processed(signalId: string): Promise<ProcessedSignal | undefined>;
  recordProcessed(value: ProcessedSignal): Promise<void>;
}
