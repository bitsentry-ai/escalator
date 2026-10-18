import type {
  SignalEvent,
  SignalSource,
  SignalToken,
  WorkspaceId,
} from "../../contracts/index.js";
import type {
  FoundationTransaction,
  Page,
  PageRequest,
} from "../ports/persistence.js";

export interface SignalTransaction extends FoundationTransaction {
  /** Live database time; read after acquiring source/token locks for expiry. */
  currentTime(): Promise<string>;
  sources: {
    get(id: string): Promise<SignalSource | undefined>;
    /** Lock source before intake and source edits. Ordinary reads never lock. */
    lock(id: string): Promise<SignalSource | undefined>;
    list(page: PageRequest): Promise<Page<SignalSource>>;
    /** Lock/check the source-bound secret metadata until this transaction commits. */
    hasUsableSecret(
      sourceId: string,
      expectedVersion: number,
    ): Promise<boolean>;
    insert(source: SignalSource): Promise<void>;
    /** Increment exactly once; source identity/kind/service/environment immutable. */
    replace(source: SignalSource, expectedVersion: number): Promise<boolean>;
  };
  tokens: {
    list(sourceId: string, page: PageRequest): Promise<Page<SignalToken>>;
    getByHash(hash: string): Promise<SignalToken | undefined>;
    /** Hash uniqueness is global; only the hash is ever persisted. */
    insert(token: SignalToken): Promise<void>;
    /** Idempotent; retains the first revocation timestamp, from live database time after the source lock. */
    revoke(id: string): Promise<boolean>;
  };
  signals: {
    get(id: string): Promise<SignalEvent | undefined>;
    /** Immutable, unique on (workspaceId, sourceId, eventId).
     * A duplicate never overwrites evidence/status or queues another job.
     */
    insert(event: SignalEvent): Promise<"inserted" | "duplicate">;
  };
}
export interface SignalRepository {
  /** A trusted authentication lookup, not a caller-selected tenant. It returns
   * no secret or event data. Acceptance must recheck the grant in transaction.
   */
  findTokenContext(
    tokenHash: string,
  ): Promise<Pick<SignalToken, "workspaceId" | "sourceId" | "id"> | undefined>;
  /** All writes, including durable work/audit, commit or roll back together.
   * Scope and closed/poisoned-transaction rules match FoundationRepository.
   * No network I/O inside callbacks. Database time is authoritative.
   */
  transaction<T>(
    workspaceId: WorkspaceId,
    run: (tx: SignalTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Scoped host primitives; each operation uses the surrounding DB transaction.
 * Only explicit source lock reads lock the row. replaceSource is a conditional update. insertSignal
 * handles its natural-key conflict atomically and never overwrites the first event.
 */
export interface SignalRecordStore {
  currentTime(): Promise<string>;
  getSource(id: string, lock?: boolean): Promise<SignalSource | undefined>;
  listSources(page: PageRequest): Promise<Page<SignalSource>>;
  insertSource(source: SignalSource): Promise<void>;
  replaceSource(
    source: SignalSource,
    expectedVersion: number,
  ): Promise<boolean>;
  /** Scope and lock enabled authorization metadata so disabling waits for commit. */
  hasSecret(id: string): Promise<boolean>;
  getTokenByHash(hash: string): Promise<SignalToken | undefined>;
  getToken(id: string): Promise<SignalToken | undefined>;
  listTokens(sourceId: string, page: PageRequest): Promise<Page<SignalToken>>;
  insertToken(token: SignalToken): Promise<void>;
  revokeToken(id: string, at: string): Promise<boolean>;
  getSignal(id: string): Promise<SignalEvent | undefined>;
  insertSignal(event: SignalEvent): Promise<"inserted" | "duplicate">;
}
