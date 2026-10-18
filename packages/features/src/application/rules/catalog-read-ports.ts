import type {
  WorkspaceId,
  RuleCatalogEntry,
  RuleActivationHistory,
  RuleCatalogList,
  RuleCatalogHistoryQuery,
  RuleCatalogView,
} from "../../contracts/index.js";
import type { FoundationTransaction } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
export interface RuleCatalogReadStore {
  /** Return at most limit+1 rows; never lock sources or initialize policy facts on reads. */
  list(input: RuleCatalogList): Promise<RuleCatalogEntry[]>;
  get(id: string): Promise<RuleCatalogView | undefined>;
  history(input: RuleCatalogHistoryQuery): Promise<RuleActivationHistory[]>;
}
export interface RuleCatalogReadTransaction extends FoundationTransaction {
  catalogRead: RuleCatalogReadStore;
}
export interface RuleCatalogReadRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleCatalogReadTransaction) => Promise<T>,
  ): Promise<T>;
}
export function withRuleCatalogRead<T extends FoundationTransaction>(
  base: T,
  store: RuleCatalogReadStore,
  guard: TransactionGuard,
): T & RuleCatalogReadTransaction {
  return {
    ...base,
    catalogRead: {
      list: (input) => guard.operation(() => store.list(input)),
      get: (id) => guard.operation(() => store.get(id)),
      history: (input) => guard.operation(() => store.history(input)),
    },
  };
}
