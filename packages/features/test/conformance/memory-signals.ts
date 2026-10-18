import {
  workspaceIdSchema,
  type SignalSource,
  type SignalToken,
  type SignalEvent,
  type WorkspaceId,
} from "../../src/contracts/index.js";
import { signalTransaction } from "../../src/application/signals/transaction.js";
import type {
  SignalRepository,
  SignalRecordStore,
  SignalTransaction,
} from "../../src/application/signals/ports.js";
import type { FoundationTransaction } from "../../src/application/ports/persistence.js";
import type { TransactionGuard } from "../../src/application/ports/transaction-guard.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import { MemoryFoundationRepository } from "./memory.js";

type Rows = {
  sources: SignalSource[];
  tokens: SignalToken[];
  signals: SignalEvent[];
};
function rows(extensions: Record<string, unknown>): Rows {
  return (extensions.signals ??= {
    sources: [],
    tokens: [],
    signals: [],
  }) as Rows;
}
/** Test-only adapter with the same serializable snapshot and poisoned guard as foundation fixtures. */
export class MemorySignalRepository implements SignalRepository {
  readonly foundation: MemoryFoundationRepository;
  constructor(
    private readonly clock = () => new Date("2026-09-20T00:00:00.000Z"),
    foundation?: MemoryFoundationRepository,
  ) {
    this.foundation =
      foundation ?? new MemoryFoundationRepository({ now: clock });
  }
  async findTokenContext(hash: string) {
    return this.foundation.withExtensions(
      workspaceIdSchema.parse("lookup"),
      async (_base, extensions) => {
        const token = rows(extensions).tokens.find(
          (row) => row.tokenHash === hash,
        );
        return token
          ? {
              workspaceId: token.workspaceId,
              sourceId: token.sourceId,
              id: token.id,
            }
          : undefined;
      },
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: SignalTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(scope, (base, extensions, guard) =>
      run(this.decorate(base, extensions, guard)),
    );
  }
  /** Compose on an existing physical fixture transaction without opening a nested snapshot. */
  decorate(
    base: FoundationTransaction,
    extensions: Record<string, unknown>,
    guard: TransactionGuard,
  ): SignalTransaction {
    const scope = base.workspaceId;
    const data = rows(extensions);
    const scoped = <T extends { workspaceId: WorkspaceId }>(values: T[]) =>
      values.filter((row) => row.workspaceId === scope);
    const copy = <T>(value: T): T => structuredClone(value);
    const store: SignalRecordStore = {
      currentTime: async () => this.clock().toISOString(),
      getSource: async (id) =>
        copy(scoped(data.sources).find((row) => row.id === id)),
      listSources: async (query) => {
        const values = scoped(data.sources)
          .filter((row) => !query.after || row.id > query.after)
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        return copy({
          items: values.slice(0, query.limit),
          next: values.length > query.limit ? values[query.limit - 1].id : null,
        });
      },
      insertSource: async (value) => {
        if (scoped(data.sources).some((row) => row.id === value.id))
          throw new PersistenceError("already_exists");
        data.sources.push(copy(value));
      },
      replaceSource: async (value, expected) => {
        const i = data.sources.findIndex(
          (row) =>
            row.workspaceId === scope &&
            row.id === value.id &&
            row.version === expected,
        );
        if (i < 0) return false;
        data.sources[i] = copy(value);
        return true;
      },
      hasSecret: async (id) => id === "fixture-secret",
      getToken: async (id) =>
        copy(scoped(data.tokens).find((row) => row.id === id)),
      getTokenByHash: async (hash) =>
        copy(scoped(data.tokens).find((row) => row.tokenHash === hash)),
      insertToken: async (value) => {
        if (
          data.tokens.some(
            (row) =>
              row.tokenHash === value.tokenHash ||
              (row.workspaceId === scope && row.id === value.id),
          )
        )
          throw new PersistenceError("already_exists");
        data.tokens.push(copy(value));
      },
      revokeToken: async (id, at) => {
        const token = scoped(data.tokens).find((row) => row.id === id);
        if (!token) return false;
        token.revokedAt ??= at;
        return true;
      },
      getSignal: async (id) =>
        copy(scoped(data.signals).find((row) => row.id === id)),
      insertSignal: async (value) => {
        if (
          scoped(data.signals).some(
            (row) =>
              row.sourceId === value.sourceId && row.eventId === value.eventId,
          )
        )
          return "duplicate";
        if (scoped(data.signals).some((row) => row.id === value.id))
          throw new PersistenceError("already_exists");
        data.signals.push(copy(value));
        return "inserted";
      },
    };
    return signalTransaction(base, store, guard);
  }
}
