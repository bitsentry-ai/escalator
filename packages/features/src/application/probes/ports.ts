import type { Probe, ProbeResult, ProbeState } from "../../contracts/probes.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import type { Page, PageRequest } from "../ports/persistence.js";
import type { SignalTransaction } from "../signals/ports.js";
import type { ProbeSchedule } from "./schedule.js";
export interface ProbeTransaction extends SignalTransaction {
  probes: {
    /** Acquire before source/probe locks when counting and changing configured capacity. */
    lockCapacity(): Promise<void>;
    get(id: string): Promise<Probe | undefined>;
    /** Takes the source lock first, then the probe lock. All mutable execution state requires this lock. */
    lock(id: string): Promise<Probe | undefined>;
    list(page: PageRequest): Promise<Page<Probe>>;
    /** Immutable source/service/environment identity; compare-and-swap version, one probe per source. */
    put(probe: Probe, expectedVersion: number | null): Promise<boolean>;
    schedule(id: string): Promise<ProbeSchedule | undefined>;
    putSchedule(value: ProbeSchedule): Promise<void>;
    state(id: string): Promise<ProbeState | undefined>;
    putState(value: ProbeState): Promise<void>;
    result(id: string): Promise<ProbeResult | undefined>;
    results(probeId: string, page: PageRequest): Promise<Page<ProbeResult>>;
    /** Immutable run receipt, atomic with threshold state, signal, successor job and audit. */
    recordResult(value: ProbeResult): Promise<void>;
  };
}
export interface ProbeRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: ProbeTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Every method uses the surrounding physical transaction and its scoped connection. */
export interface ProbeRecordStore {
  lockCapacity(): Promise<void>;
  get(id: string, lock?: boolean): Promise<Probe | undefined>;
  list(page: PageRequest): Promise<Page<Probe>>;
  put(value: Probe, expectedVersion: number | null): Promise<boolean>;
  hasSecret(id: string): Promise<boolean>;
  schedule(probeId: string): Promise<ProbeSchedule | undefined>;
  putSchedule(value: ProbeSchedule): Promise<void>;
  state(probeId: string): Promise<ProbeState | undefined>;
  putState(value: ProbeState): Promise<void>;
  result(id: string): Promise<ProbeResult | undefined>;
  results(probeId: string, page: PageRequest): Promise<Page<ProbeResult>>;
  recordResult(value: ProbeResult): Promise<void>;
}
