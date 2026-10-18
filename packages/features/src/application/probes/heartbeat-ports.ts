import type {
  Heartbeat,
  HeartbeatState,
  HeartbeatReceipt,
  HeartbeatGrant,
} from "../../contracts/heartbeat.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import type { Page, PageRequest } from "../ports/persistence.js";
import type { SignalTransaction } from "../signals/ports.js";
export interface HeartbeatTransaction extends SignalTransaction {
  heartbeats: {
    get(id: string): Promise<Heartbeat | undefined>;
    /** Source first, then heartbeat; every deadline/ping/edit takes this lock. */
    lock(id: string): Promise<Heartbeat | undefined>;
    list(page: PageRequest): Promise<Page<Heartbeat>>;
    put(value: Heartbeat, expectedVersion: number | null): Promise<boolean>;
    state(id: string): Promise<HeartbeatState | undefined>;
    putState(value: HeartbeatState): Promise<void>;
    receipt(
      probeId: string,
      eventId: string,
    ): Promise<HeartbeatReceipt | undefined>;
    insertReceipt(value: HeartbeatReceipt): Promise<void>;
    grants(probeId: string, page: PageRequest): Promise<Page<HeartbeatGrant>>;
    grantByHash(hash: string): Promise<HeartbeatGrant | undefined>;
    insertGrant(value: HeartbeatGrant): Promise<void>;
    revokeGrant(probeId: string, grantId: string): Promise<boolean>;
  };
}
export interface HeartbeatRepository {
  findGrantContext(
    hash: string,
  ): Promise<Pick<HeartbeatGrant, "workspaceId" | "probeId"> | undefined>;
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: HeartbeatTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface HeartbeatRecordStore {
  get(id: string, lock?: boolean): Promise<Heartbeat | undefined>;
  list(page: PageRequest): Promise<Page<Heartbeat>>;
  put(value: Heartbeat, expectedVersion: number | null): Promise<boolean>;
  state(id: string): Promise<HeartbeatState | undefined>;
  putState(value: HeartbeatState): Promise<void>;
  receipt(
    probeId: string,
    eventId: string,
  ): Promise<HeartbeatReceipt | undefined>;
  insertReceipt(value: HeartbeatReceipt): Promise<void>;
  grants(probeId: string, page: PageRequest): Promise<Page<HeartbeatGrant>>;
  grantByHash(hash: string): Promise<HeartbeatGrant | undefined>;
  grant(id: string): Promise<HeartbeatGrant | undefined>;
  insertGrant(value: HeartbeatGrant): Promise<void>;
  revokeGrant(id: string, now: string): Promise<boolean>;
}
