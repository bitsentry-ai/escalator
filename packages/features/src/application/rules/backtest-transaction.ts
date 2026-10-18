import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { RuleReplayTransaction } from "./replay-ports.js";
import type {
  RuleBacktestStore,
  RuleBacktestTransaction,
} from "./backtest-ports.js";
/** Report failures poison the same foundation transaction, including caught errors. */
export function withRuleBacktests<T extends RuleReplayTransaction>(
  base: T,
  store: RuleBacktestStore,
  guard: TransactionGuard,
): T & RuleBacktestTransaction {
  return {
    ...base,
    reports: {
      chunks: (id) => guard.operation(() => store.chunks(id)),
      labels: (snapshot) => guard.operation(() => store.labels(snapshot)),
      get: (id) => guard.operation(() => store.get(id)),
      insert: (row) => guard.operation(() => store.insert(row)),
    },
  };
}
