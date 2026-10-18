import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { RuleReplayTransaction } from "./replay-ports.js";
import type {
  RuleReplayCaptureStore,
  RuleReplayCaptureTransaction,
} from "./replay-capture.js";
/** Capture primitives share the replay/foundation transaction. Even a caught
 * storage failure poisons it; one reservation creates at most one run. */
export function withRuleReplayCapture<T extends RuleReplayTransaction>(
  base: T,
  store: RuleReplayCaptureStore,
  guard: TransactionGuard,
): T & RuleReplayCaptureTransaction {
  let reserved = false,
    inserted = false;
  return {
    ...base,
    capture: {
      reserve: () =>
        guard.operation(async () => {
          if (reserved) throw new Error("Replay capacity already reserved");
          await store.reserve();
          reserved = true;
        }),
      evidence: (version, range) =>
        guard.operation(() => {
          if (!reserved || inserted)
            throw new Error("Replay capture has no reservation");
          return store.evidence(version, range);
        }),
      insert: (snapshot, run) =>
        guard.operation(async () => {
          if (!reserved || inserted)
            throw new Error("Replay capture has no reservation");
          await store.insert(snapshot, run);
          inserted = true;
        }),
    },
  };
}
