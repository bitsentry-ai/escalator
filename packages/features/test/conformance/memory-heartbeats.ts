import {
  workspaceIdSchema,
  type WorkspaceId,
} from "../../src/contracts/identity.js";
import type {
  Heartbeat,
  HeartbeatState,
  HeartbeatReceipt,
  HeartbeatGrant,
} from "../../src/contracts/heartbeat.js";
import type {
  HeartbeatRepository,
  HeartbeatTransaction,
  HeartbeatRecordStore,
} from "../../src/application/probes/heartbeat-ports.js";
import { heartbeatTransaction } from "../../src/application/probes/heartbeat-transaction.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import { MemorySignalRepository } from "./memory-signals.js";
type Rows = {
  probes: Heartbeat[];
  states: HeartbeatState[];
  receipts: HeartbeatReceipt[];
  grants: HeartbeatGrant[];
};
function rows(extensions: Record<string, unknown>): Rows {
  return (extensions.heartbeats ??= {
    probes: [],
    states: [],
    receipts: [],
    grants: [],
  }) as Rows;
}
export class MemoryHeartbeatRepository implements HeartbeatRepository {
  readonly signals: MemorySignalRepository;
  constructor(clock = () => new Date("2026-10-03T00:00:00.000Z")) {
    this.signals = new MemorySignalRepository(clock);
  }
  async findGrantContext(hash: string) {
    return this.signals.foundation.withExtensions(
      workspaceIdSchema.parse("lookup"),
      async (_base, extensions) => {
        const grant = rows(extensions).grants.find(
          (row) => row.tokenHash === hash,
        );
        return grant
          ? { workspaceId: grant.workspaceId, probeId: grant.probeId }
          : undefined;
      },
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: HeartbeatTransaction) => Promise<T>,
  ): Promise<T> {
    return this.signals.foundation.withExtensions(
      scope,
      (base, extensions, guard) => {
        const data = rows(extensions);
        const scoped = <T extends { workspaceId: WorkspaceId }>(values: T[]) =>
          values.filter((value) => value.workspaceId === scope);
        const copy = <T>(value: T): T => structuredClone(value);
        const unique = (duplicate: boolean) => {
          if (duplicate) throw new PersistenceError("already_exists");
        };
        const store: HeartbeatRecordStore = {
          get: async (id) =>
            copy(scoped(data.probes).find((row) => row.id === id)),
          list: async (input) => {
            const sorted = scoped(data.probes)
              .filter((row) => !input.after || row.id > input.after)
              .sort((a, b) => (a.id < b.id ? -1 : 1));
            return copy({
              items: sorted.slice(0, input.limit),
              next:
                sorted.length > input.limit ? sorted[input.limit - 1].id : null,
            });
          },
          put: async (value, expected) => {
            const index = data.probes.findIndex(
              (row) => row.workspaceId === scope && row.id === value.id,
            );
            if ((data.probes[index]?.version ?? null) !== expected)
              return false;
            unique(
              scoped(data.probes).some(
                (row) => row.sourceId === value.sourceId && row.id !== value.id,
              ),
            );
            if (index < 0) data.probes.push(copy(value));
            else data.probes[index] = copy(value);
            return true;
          },
          state: async (id) =>
            copy(scoped(data.states).find((row) => row.probeId === id)),
          putState: async (value) => {
            const index = data.states.findIndex(
              (row) =>
                row.workspaceId === scope && row.probeId === value.probeId,
            );
            if (index < 0) data.states.push(copy(value));
            else data.states[index] = copy(value);
          },
          receipt: async (id, eventId) =>
            copy(
              scoped(data.receipts).find(
                (row) => row.probeId === id && row.eventId === eventId,
              ),
            ),
          insertReceipt: async (value) => {
            unique(
              scoped(data.receipts).some(
                (row) =>
                  row.id === value.id ||
                  (row.probeId === value.probeId &&
                    row.eventId === value.eventId),
              ),
            );
            data.receipts.push(copy(value));
          },
          grantByHash: async (hash) =>
            copy(scoped(data.grants).find((row) => row.tokenHash === hash)),
          grant: async (id) =>
            copy(scoped(data.grants).find((row) => row.id === id)),
          insertGrant: async (value) => {
            unique(
              data.grants.some(
                (row) =>
                  row.tokenHash === value.tokenHash ||
                  (row.workspaceId === scope && row.id === value.id),
              ),
            );
            data.grants.push(copy(value));
          },
          revokeGrant: async (id, at) => {
            const grant = scoped(data.grants).find((row) => row.id === id);
            if (!grant) return false;
            grant.revokedAt ??= at;
            return true;
          },
        };
        return run(
          heartbeatTransaction(
            this.signals.decorate(base, extensions, guard),
            store,
            guard,
          ),
        );
      },
    );
  }
}
