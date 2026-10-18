import type {
  Environment,
  Responder,
  Service,
  Workspace,
  WorkspaceId,
} from "../../contracts/index.js";
import type { AuditRepository } from "./audit.js";

export class PersistenceError extends Error {
  constructor(
    public readonly code:
      | "scope_violation"
      | "already_exists"
      | "not_found"
      | "closed_transaction"
      | "invalid_page",
  ) {
    super(code);
    this.name = "PersistenceError";
  }
}
export interface PageRequest {
  limit: number;
  after?: string;
}
export interface Page<T> {
  items: T[];
  next: string | null;
}
export interface EntityRepository<
  T extends { id: string; workspaceId: WorkspaceId },
> {
  /** Another workspace's ID is indistinguishable from a missing record. */
  get(id: T["id"]): Promise<T | undefined>;
  list(page: PageRequest): Promise<Page<T>>;
  /** Reject scope mismatch and duplicate ID or natural key without overwriting. */
  insert(value: T): Promise<void>;
}
export interface FoundationTransaction {
  readonly workspaceId: WorkspaceId;
  /** UTC database transaction time, not the caller's wall clock. */
  readonly now: string;
  workspace: {
    get(): Promise<Workspace | undefined>;
    insert(value: Workspace): Promise<void>;
  };
  services: EntityRepository<Service>;
  environments: EntityRepository<Environment>;
  responders: EntityRepository<Responder>;
  audit: AuditRepository;
}
export interface FoundationRepository {
  /** Atomic, isolated callback. Await every operation; no network I/O inside it.
   * Handles expire when the callback finishes. Any repository operation error
   * rolls back every write, even if the callback catches it. Retry outside.
   */
  transaction<T>(
    workspaceId: WorkspaceId,
    work: (tx: FoundationTransaction) => Promise<T>,
  ): Promise<T>;
}
