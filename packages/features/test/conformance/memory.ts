import {
  memoryWorkWriter,
  memoryClaim,
  memorySettle,
  type MemoryWork,
} from "./memory-work.js";
import type {
  DurableWorkStore,
  WorkLease,
  WorkResult,
} from "../../src/application/jobs/ports.js";
import {
  TransactionGuard,
  protectFoundationTransaction,
} from "../../src/application/ports/transaction-guard.js";
import type {
  Clock,
  Environment,
  Responder,
  Service,
  Workspace,
  WorkspaceId,
} from "../../src/contracts/index.js";
import {
  environmentSchema,
  responderSchema,
  serviceSchema,
  workspaceSchema,
} from "../../src/contracts/index.js";
import type { AuditEvent } from "../../src/application/ports/audit.js";
import {
  PersistenceError,
  type EntityRepository,
  type FoundationRepository,
  type FoundationTransaction,
  type Page,
  type PageRequest,
} from "../../src/application/ports/persistence.js";

type State = {
  workspaces: Workspace[];
  services: Service[];
  environments: Environment[];
  responders: Responder[];
  audits: AuditEvent[];
  work: MemoryWork[];
  extensions: Record<string, unknown>;
};
function page<T extends { id: string }>(
  values: T[],
  query: PageRequest,
): Page<T> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new PersistenceError("invalid_page");
  const sorted = values
    .filter((value) => !query.after || value.id > query.after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = sorted.slice(0, query.limit);
  return {
    items: structuredClone(items),
    next: sorted.length > query.limit ? items[items.length - 1].id : null,
  };
}

/** Test adapter: serializable transactions, deliberately no production runtime. */
export class MemoryFoundationRepository
  implements FoundationRepository, DurableWorkStore
{
  private state: State = {
    workspaces: [],
    services: [],
    environments: [],
    responders: [],
    audits: [],
    work: [],
    extensions: {},
  };
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly clock: Clock) {}
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async claim(
    input: Parameters<DurableWorkStore["claim"]>[0],
  ): Promise<WorkLease | undefined> {
    return this.serialized(async () => {
      const draft = structuredClone(this.state);
      const lease = memoryClaim(draft.work, input, this.clock.now());
      this.state = draft;
      return lease;
    });
  }
  async settle(lease: WorkLease, result: WorkResult): Promise<boolean> {
    return this.serialized(async () => {
      const draft = structuredClone(this.state);
      const accepted = memorySettle(
        draft.work,
        lease,
        result,
        this.clock.now(),
      );
      this.state = draft;
      return accepted;
    });
  }
  async committed(lease: WorkLease): Promise<boolean> {
    return this.serialized(async () =>
      this.state.work.some(
        (row) =>
          row.workspaceId === lease.workspaceId &&
          row.queue === lease.queue &&
          row.intent.id === lease.id &&
          row.token === lease.token &&
          row.state === "running",
      ),
    );
  }
  async expireLease(lease: WorkLease): Promise<void> {
    await this.serialized(async () => {
      const row = this.state.work.find(
        (row) =>
          row.workspaceId === lease.workspaceId &&
          row.queue === lease.queue &&
          row.intent.id === lease.id,
      );
      if (!row || row.token !== lease.token)
        throw new Error("Fixture lease not found");
      row.leaseExpiresAt = new Date(
        this.clock.now().getTime() - 1,
      ).toISOString();
    });
  }
  async transaction<T>(
    workspaceId: WorkspaceId,
    work: (tx: FoundationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withExtensions(workspaceId, (tx) => work(tx));
  }
  async withExtensions<T>(
    workspaceId: WorkspaceId,
    work: (
      tx: FoundationTransaction,
      extensions: Record<string, unknown>,
      guard: TransactionGuard,
    ) => Promise<T>,
  ): Promise<T> {
    return this.serialized(async () => {
      const guard = new TransactionGuard();
      try {
        const state = structuredClone(this.state);
        const check = () => {
          guard.assertCommittable();
        };
        const scope = (id: WorkspaceId) => {
          check();
          if (id !== workspaceId) throw new PersistenceError("scope_violation");
        };
        const exists = () => {
          if (!state.workspaces.some((value) => value.id === workspaceId))
            throw new PersistenceError("not_found");
        };
        function repository<E extends { id: string; workspaceId: WorkspaceId }>(
          rows: E[],
          parse: (input: unknown) => E,
          naturalKey: (value: E) => string,
        ): EntityRepository<E> {
          return {
            async get(id) {
              check();
              return structuredClone(
                rows.find(
                  (value) =>
                    value.workspaceId === workspaceId && value.id === id,
                ),
              );
            },
            async list(query) {
              check();
              return page(
                rows.filter((value) => value.workspaceId === workspaceId),
                query,
              );
            },
            async insert(input) {
              scope(input.workspaceId);
              exists();
              const value = parse(input);
              if (
                rows.some(
                  (row) =>
                    row.workspaceId === workspaceId &&
                    (row.id === value.id ||
                      naturalKey(row) === naturalKey(value)),
                )
              )
                throw new PersistenceError("already_exists");
              rows.push(structuredClone(value));
            },
          };
        }
        const raw: FoundationTransaction = {
          work: memoryWorkWriter(state.work, workspaceId, exists),
          workspaceId,
          now: this.clock.now().toISOString(),
          workspace: {
            async get() {
              check();
              return structuredClone(
                state.workspaces.find((value) => value.id === workspaceId),
              );
            },
            async insert(input) {
              scope(input.id);
              const value = workspaceSchema.parse(input);
              if (state.workspaces.some((row) => row.id === value.id))
                throw new PersistenceError("already_exists");
              state.workspaces.push(structuredClone(value));
            },
          },
          services: repository(
            state.services,
            serviceSchema.parse,
            (value) => value.key,
          ),
          environments: repository(
            state.environments,
            environmentSchema.parse,
            (value) => value.key,
          ),
          responders: repository(
            state.responders,
            responderSchema.parse,
            (value) => value.hostUserId,
          ),
          audit: {
            async append(event) {
              scope(event.workspaceId);
              exists();
              if (
                state.audits.some(
                  (row) =>
                    row.workspaceId === workspaceId && row.id === event.id,
                )
              )
                throw new PersistenceError("already_exists");
              state.audits.push(structuredClone(event));
            },
            async list(query) {
              check();
              return page(
                state.audits.filter((row) => row.workspaceId === workspaceId),
                query,
              );
            },
          },
        };
        const tx = protectFoundationTransaction(raw, guard);
        const result = await work(tx, state.extensions, guard);
        guard.assertCommittable();
        this.state = state;
        return result;
      } finally {
        guard.close();
      }
    });
  }
}
