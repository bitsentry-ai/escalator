import type { WorkspaceId } from "../../src/contracts/index.js";
import { configurationTransaction } from "../../src/application/configuration/transaction.js";
import type {
  ConfigurationRepository,
  ConfigurationTransaction,
  ConfigurationRecordMap,
  ConfigurationKind,
  ConfigurationRecordStore,
} from "../../src/application/configuration/ports.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import { MemoryPagingRepository } from "./memory-paging.js";
export class MemoryConfigurationRepository implements ConfigurationRepository {
  readonly paging = new MemoryPagingRepository({
    now: () => new Date("2026-09-20T00:00:00.000Z"),
  });
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: ConfigurationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.paging.withExtensions(scope, (base, extensions, guard) => {
      type Rows = Record<
        ConfigurationKind,
        ConfigurationRecordMap[ConfigurationKind][]
      >;
      const data = (extensions.configuration ?? {
        schedules: [],
        policies: [],
        contacts: [],
        availability: [],
        previews: [],
      }) as Rows;
      extensions.configuration = data;
      const rows = <K extends ConfigurationKind>(kind: K) =>
        data[kind].filter(
          (r) => r.workspaceId === scope,
        ) as ConfigurationRecordMap[K][];
      const store: ConfigurationRecordStore = {
        get: async (kind, id) =>
          structuredClone(rows(kind).find((r) => r.id === id)),
        list: async (kind, input, parent) => {
          const values = rows(kind)
            .filter((r) => !input.after || r.id > input.after)
            .filter(
              (r) =>
                parent === undefined ||
                ("scheduleId" in r
                  ? r.scheduleId
                  : "responderId" in r
                    ? r.responderId
                    : undefined) === parent,
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          return structuredClone({
            items: values.slice(0, input.limit),
            next:
              values.length > input.limit ? values[input.limit - 1].id : null,
          });
        },
        insert: async (kind, value) => {
          if (rows(kind).some((r) => r.id === value.id))
            throw new PersistenceError("already_exists");
          data[kind].push(structuredClone(value));
        },
        replace: async (kind, value) => {
          const index = data[kind].findIndex(
            (r) => r.workspaceId === scope && r.id === value.id,
          );
          if (index < 0) throw new PersistenceError("not_found");
          data[kind][index] = structuredClone(value);
        },
        secretExists: async (id) => id === "fixture-secret",
      };
      return work(configurationTransaction(base, store, guard));
    });
  }
}
