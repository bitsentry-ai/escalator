import type {
  WorkspaceId,
  MetricMonitor,
  MetricSchedule,
  MetricObservationRecord,
} from "../../src/contracts/index.js";
import type {
  MetricsRepository,
  MetricsTransaction,
  MetricsRecordStore,
} from "../../src/application/metrics/ports.js";
import { metricsTransaction } from "../../src/application/metrics/transaction.js";
import {
  PersistenceError,
  type PageRequest,
} from "../../src/application/ports/persistence.js";
import { MemorySignalRepository } from "./memory-signals.js";
import { compareCodeUnits } from "../../src/contracts/ordering.js";
type Rows = {
  monitors: MetricMonitor[];
  versions: MetricMonitor[];
  schedules: MetricSchedule[];
  observations: MetricObservationRecord[];
};
const byReceipt = (a: MetricObservationRecord, b: MetricObservationRecord) =>
  Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
  compareCodeUnits(a.id, b.id);
export class MemoryMetricsRepository implements MetricsRepository {
  readonly signals: MemorySignalRepository;
  constructor(
    clock = () => new Date("2026-10-03T00:00:00.000Z"),
    private readonly secretAvailable = (id: string) => id === "fixture-secret",
  ) {
    this.signals = new MemorySignalRepository(clock);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: MetricsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.signals.foundation.withExtensions(
      scope,
      (base, extensions, guard) => {
        const data = (extensions.metrics ??= {
          monitors: [],
          versions: [],
          schedules: [],
          observations: [],
        }) as Rows;
        const scoped = <T extends { workspaceId: WorkspaceId }>(rows: T[]) =>
          rows.filter((row) => row.workspaceId === scope);
        const copy = <T>(value: T): T => structuredClone(value);
        const paged = <T extends { id: string }>(
          rows: T[],
          page: PageRequest,
        ) =>
          copy({
            items: rows.slice(0, page.limit),
            next: rows.length > page.limit ? rows[page.limit - 1].id : null,
          });
        const store: MetricsRecordStore = {
          lockCapacity: async () => {},
          get: async (id) =>
            copy(scoped(data.monitors).find((row) => row.id === id)),
          list: async (page) =>
            paged(
              scoped(data.monitors)
                .filter((row) => !page.after || row.id > page.after)
                .sort((a, b) => (a.id < b.id ? -1 : 1)),
              page,
            ),
          put: async (value, expected) => {
            const index = data.monitors.findIndex(
              (row) => row.workspaceId === scope && row.id === value.id,
            );
            if ((data.monitors[index]?.version ?? null) !== expected)
              return false;
            if (
              scoped(data.monitors).some(
                (row) => row.sourceId === value.sourceId && row.id !== value.id,
              ) ||
              scoped(data.versions).some(
                (row) => row.id === value.id && row.version === value.version,
              )
            )
              throw new PersistenceError("already_exists");
            if (index < 0) data.monitors.push(copy(value));
            else data.monitors[index] = copy(value);
            data.versions.push(copy(value));
            return true;
          },
          version: async (id, version) =>
            copy(
              scoped(data.versions).find(
                (row) => row.id === id && row.version === version,
              ),
            ),
          hasSecret: async (id) => this.secretAvailable(id),
          schedule: async (id) =>
            copy(scoped(data.schedules).find((row) => row.monitorId === id)),
          putSchedule: async (value) => {
            const index = data.schedules.findIndex(
              (row) =>
                row.workspaceId === scope && row.monitorId === value.monitorId,
            );
            if (index < 0) data.schedules.push(copy(value));
            else data.schedules[index] = copy(value);
          },
          observation: async (id) =>
            copy(scoped(data.observations).find((row) => row.id === id)),
          history: async (id, page) => {
            const rows = scoped(data.observations)
              .filter((row) => row.monitorId === id)
              .sort((a, b) => -byReceipt(a, b));
            const cursor = page.after
              ? rows.find((row) => row.id === page.after)
              : undefined;
            // An unknown cursor pages past the end.
            let remaining = rows;
            if (page.after)
              remaining = cursor
                ? rows.filter((row) => byReceipt(row, cursor) < 0)
                : [];
            return paged(remaining, page);
          },
          window: async (query) => {
            const selected = new Map<string, MetricObservationRecord>();
            for (const row of scoped(data.observations)) {
              if (
                row.monitorId !== query.monitorId ||
                row.monitorVersion !== query.monitorVersion ||
                Date.parse(row.observedAt) < Date.parse(query.startAt) ||
                Date.parse(row.observedAt) > Date.parse(query.endAt) ||
                Date.parse(row.receivedAt) > Date.parse(query.visibleAt)
              )
                continue;
              const old = selected.get(row.observedAt);
              if (!old || byReceipt(row, old) > 0)
                selected.set(row.observedAt, row);
            }
            return copy(
              [...selected.values()]
                .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
                .slice(0, query.limit),
            );
          },
          recordObservation: async (value) => {
            if (scoped(data.observations).some((row) => row.id === value.id))
              throw new PersistenceError("already_exists");
            data.observations.push(copy(value));
          },
        };
        return run(
          metricsTransaction(
            this.signals.decorate(base, extensions, guard),
            store,
            guard,
          ),
        );
      },
    );
  }
}
