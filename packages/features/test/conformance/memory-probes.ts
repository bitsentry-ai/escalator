import type {
  Probe,
  ProbeResult,
  ProbeState,
  WorkspaceId,
} from "../../src/contracts/index.js";
import { probeTransaction } from "../../src/application/probes/transaction.js";
import type {
  ProbeRecordStore,
  ProbeRepository,
  ProbeTransaction,
} from "../../src/application/probes/ports.js";
import type { ProbeSchedule } from "../../src/application/probes/schedule.js";
import {
  PersistenceError,
  type PageRequest,
} from "../../src/application/ports/persistence.js";
import { MemorySignalRepository } from "./memory-signals.js";
type Rows = {
  probes: Probe[];
  states: ProbeState[];
  results: ProbeResult[];
  schedules: ProbeSchedule[];
};
export class MemoryProbeRepository implements ProbeRepository {
  readonly signals: MemorySignalRepository;
  constructor(
    clock = () => new Date("2026-09-20T00:00:00.000Z"),
    private readonly secretAvailable: (id: string) => boolean = (id) =>
      id === "fixture-secret",
  ) {
    this.signals = new MemorySignalRepository(clock);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: ProbeTransaction) => Promise<T>,
  ): Promise<T> {
    return this.signals.foundation.withExtensions(
      scope,
      (base, extensions, guard) => {
        const rows = (extensions.probes ??= {
          probes: [],
          states: [],
          results: [],
          schedules: [],
        }) as Rows;
        const scoped = <T extends { workspaceId: WorkspaceId }>(values: T[]) =>
          values.filter((value) => value.workspaceId === scope);
        const copy = <T>(value: T): T => structuredClone(value);
        const list = <T extends { id: string }>(
          values: T[],
          input: PageRequest,
        ) => {
          const sorted = values
            .filter((value) => !input.after || value.id > input.after)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          return copy({
            items: sorted.slice(0, input.limit),
            next:
              sorted.length > input.limit ? sorted[input.limit - 1].id : null,
          });
        };
        const upsert = <T extends { workspaceId: WorkspaceId }>(
          values: T[],
          value: T,
          key: (row: T) => string,
        ) => {
          const index = values.findIndex(
            (row) => row.workspaceId === scope && key(row) === key(value),
          );
          if (index < 0) values.push(copy(value));
          else values[index] = copy(value);
        };
        const store: ProbeRecordStore = {
          get: async (id) =>
            copy(scoped(rows.probes).find((row) => row.id === id)),
          list: async (input) => list(scoped(rows.probes), input),
          put: async (value, expected) => {
            const current = scoped(rows.probes).find(
              (row) => row.id === value.id,
            );
            if ((current?.version ?? null) !== expected) return false;
            if (
              scoped(rows.probes).some(
                (row) => row.sourceId === value.sourceId && row.id !== value.id,
              )
            )
              throw new PersistenceError("already_exists");
            upsert(rows.probes, value, (row) => row.id);
            return true;
          },
          hasSecret: async (id) => this.secretAvailable(id),
          schedule: async (id) =>
            copy(scoped(rows.schedules).find((row) => row.probeId === id)),
          putSchedule: async (value) =>
            upsert(rows.schedules, value, (row) => row.probeId),
          state: async (id) =>
            copy(scoped(rows.states).find((row) => row.probeId === id)),
          putState: async (value) =>
            upsert(rows.states, value, (row) => row.probeId),
          result: async (id) =>
            copy(scoped(rows.results).find((row) => row.id === id)),
          results: async (id, input) =>
            list(
              scoped(rows.results).filter((row) => row.probeId === id),
              input,
            ),
          recordResult: async (value) => {
            if (scoped(rows.results).some((row) => row.id === value.id))
              throw new PersistenceError("already_exists");
            rows.results.push(copy(value));
          },
        };
        return run(
          probeTransaction(
            this.signals.decorate(base, extensions, guard),
            store,
            guard,
          ),
        );
      },
    );
  }
}
