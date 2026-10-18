import type { FoundationTransaction } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  RuleCatalogStore,
  RuleCatalogTransaction,
} from "./activation-ports.js";
/** Retain the host foundation's guard for every catalog primitive. A caught
 * parsing/query failure must still prevent commit, and saved handles expire. */
export function withRuleCatalog<T extends FoundationTransaction>(
  base: T,
  store: RuleCatalogStore,
  guard: TransactionGuard,
): T & RuleCatalogTransaction {
  return {
    ...base,
    catalog: {
      currentTime: () => guard.operation(() => store.currentTime()),
      lockDefinition: (version) =>
        guard.operation(() => store.lockDefinition(version)),
      lock: (id) => guard.operation(() => store.lock(id)),
      version: (id, revision) =>
        guard.operation(() => store.version(id, revision)),
      latestVersionRevision: (id) =>
        guard.operation(() => store.latestVersionRevision(id)),
      insert: (entry, version) =>
        guard.operation(() => store.insert(entry, version)),
      insertVersion: (version) =>
        guard.operation(() => store.insertVersion(version)),
      save: (entry, expected) =>
        guard.operation(() => store.save(entry, expected)),
      runtime: (id) => guard.operation(() => store.runtime(id)),
      retireRuntime: (id) => guard.operation(() => store.retireRuntime(id)),
      activateRuntime: (row) =>
        guard.operation(() => store.activateRuntime(row)),
      review: (id) => guard.operation(() => store.review(id)),
      insertReview: (receipt) =>
        guard.operation(() => store.insertReview(receipt)),
      history: (row) => guard.operation(() => store.history(row)),
      evidence: (entry, version, runId) =>
        guard.operation(() => store.evidence(entry, version, runId)),
    },
  };
}
