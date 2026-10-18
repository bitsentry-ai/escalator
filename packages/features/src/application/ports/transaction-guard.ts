import {
  PersistenceError,
  type EntityRepository,
  type FoundationTransaction,
} from "./persistence.js";
import type { WorkspaceId } from "../../contracts/index.js";

/** Adapters use the same fail-closed lifetime, including caught operation errors. */
export class TransactionGuard {
  private active = true;
  private failure: { cause: unknown } | undefined;

  constructor(
    private readonly normalize: (error: unknown) => unknown = (error) => error,
  ) {}

  assertCommittable(): void {
    if (!this.active) throw new PersistenceError("closed_transaction");
    if (this.failure) throw this.failure.cause;
  }

  async operation<T>(work: () => T | Promise<T>): Promise<T> {
    this.assertCommittable();
    try {
      return await work();
    } catch (error) {
      const cause = this.normalize(error);
      this.failure ??= { cause };
      throw cause;
    }
  }

  close(): void {
    this.active = false;
  }
}

/** Wrap every foundation operation without importing a host or database client. */
export function protectFoundationTransaction(
  raw: FoundationTransaction,
  guard: TransactionGuard,
): FoundationTransaction {
  const protect = <E extends { id: string; workspaceId: WorkspaceId }>(
    repo: EntityRepository<E>,
  ): EntityRepository<E> => ({
    get: (id) => guard.operation(() => repo.get(id)),
    list: (query) => guard.operation(() => repo.list(query)),
    insert: (value) => guard.operation(() => repo.insert(value)),
  });
  return {
    workspaceId: raw.workspaceId,
    now: raw.now,
    workspace: {
      get: () => guard.operation(() => raw.workspace.get()),
      insert: (value) => guard.operation(() => raw.workspace.insert(value)),
    },
    services: protect(raw.services),
    environments: protect(raw.environments),
    responders: protect(raw.responders),
    audit: {
      append: (event) => guard.operation(() => raw.audit.append(event)),
      list: (query) => guard.operation(() => raw.audit.list(query)),
    },
  };
}
