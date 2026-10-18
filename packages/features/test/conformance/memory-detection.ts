import type { TransactionGuard } from "../../src/application/ports/transaction-guard.js";
import type { WorkspaceId } from "../../src/contracts/index.js";
import type {
  AlertGroup,
  AlertState,
  ProcessedSignal,
  ServiceEnvironment,
} from "../../src/contracts/alerts.js";
import type {
  DetectionRepository,
  DetectionTransaction,
  DetectionRecordStore,
} from "../../src/application/detection/ports.js";
import { detectionTransaction } from "../../src/application/detection/transaction.js";
import {
  PersistenceError,
  type PageRequest,
} from "../../src/application/ports/persistence.js";
import { MemoryConfigurationRepository } from "./memory-configuration.js";
import { MemorySignalRepository } from "./memory-signals.js";
type Rows = {
  bindings: ServiceEnvironment[];
  groups: AlertGroup[];
  alerts: AlertState[];
  processed: ProcessedSignal[];
};
export class MemoryDetectionRepository implements DetectionRepository {
  readonly configuration: MemoryConfigurationRepository;
  readonly signals: MemorySignalRepository;
  constructor(clock = () => new Date("2026-09-20T00:00:00.000Z")) {
    this.configuration = new MemoryConfigurationRepository({ now: clock });
    this.signals = new MemorySignalRepository(
      clock,
      this.configuration.paging.foundation,
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: DetectionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withExtensions(scope, (tx) => work(tx));
  }
  withExtensions<T>(
    scope: WorkspaceId,
    work: (
      tx: DetectionTransaction,
      extensions: Record<string, unknown>,
      guard: TransactionGuard,
    ) => Promise<T>,
  ): Promise<T> {
    return this.configuration.withExtensions(
      scope,
      (base, extensions, guard) => {
        const rows = (extensions.detection ??= {
          bindings: [],
          groups: [],
          alerts: [],
          processed: [],
        }) as Rows;
        const copy = <V>(value: V): V => structuredClone(value);
        const scoped = <V extends { workspaceId: WorkspaceId }>(values: V[]) =>
          values.filter((row) => row.workspaceId === scope);
        const list = <V extends { id: string }>(
          values: V[],
          query: PageRequest,
        ) => {
          const sorted = values
            .filter((row) => !query.after || row.id > query.after)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          return copy({
            items: sorted.slice(0, query.limit),
            next:
              sorted.length > query.limit ? sorted[query.limit - 1].id : null,
          });
        };
        const put = <V extends { workspaceId: WorkspaceId; id: string }>(
          values: V[],
          value: V,
        ) => {
          const index = values.findIndex(
            (row) => row.workspaceId === scope && row.id === value.id,
          );
          if (index < 0) values.push(copy(value));
          else values[index] = copy(value);
        };
        const store: DetectionRecordStore = {
          binding: async (serviceId, environmentId) =>
            copy(
              scoped(rows.bindings).find(
                (row) =>
                  row.serviceId === serviceId &&
                  row.environmentId === environmentId,
              ),
            ),
          bindings: async (query) => list(scoped(rows.bindings), query),
          putBinding: async (value, expected) => {
            const current = scoped(rows.bindings).find(
              (row) =>
                row.serviceId === value.serviceId &&
                row.environmentId === value.environmentId,
            );
            if ((current?.version ?? null) !== expected) return false;
            put(rows.bindings, value);
            return true;
          },
          lockGroup: async (key) =>
            copy(scoped(rows.groups).find((row) => row.id === key)),
          putGroup: async (value, expected) => {
            const current = scoped(rows.groups).find(
              (row) => row.id === value.id,
            );
            if ((current?.revision ?? null) !== expected) return false;
            put(rows.groups, value);
            return true;
          },
          alert: async (id) =>
            copy(scoped(rows.alerts).find((row) => row.id === id)),
          putAlert: async (value) => {
            put(rows.alerts, value);
          },
          forIncident: async (id, query) =>
            list(
              scoped(rows.alerts).filter((row) => row.incidentId === id),
              query,
            ),
          processed: async (id) =>
            copy(scoped(rows.processed).find((row) => row.id === id)),
          recordProcessed: async (value) => {
            if (scoped(rows.processed).some((row) => row.id === value.id))
              throw new PersistenceError("already_exists");
            rows.processed.push(copy(value));
          },
        };
        return work(
          detectionTransaction(
            { ...base, ...this.signals.decorate(base, extensions, guard) },
            store,
            guard,
          ),
          extensions,
          guard,
        );
      },
    );
  }
}
