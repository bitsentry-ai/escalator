import type { FoundationTransaction } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  ReplayPruneTransaction,
  ReplayPruneSnapshot,
  ReplayPruneCursor,
} from "./pruning.js";
export interface ReplayPruneStore {
  snapshot(after: ReplayPruneCursor | null): Promise<ReplayPruneSnapshot>;
  remove(
    selected: { kind: "signal" | "probe" | "metric"; id: string }[],
  ): Promise<{
    deletedRows: number;
    deletedBytes: number;
    retainedBytes: number;
  }>;
}
/** Prevents reuse of a selection across snapshots or after releasing physical locks. */
export function replayPruneTransaction(
  base: FoundationTransaction,
  store: ReplayPruneStore,
  guard: TransactionGuard,
): ReplayPruneTransaction {
  let snapshot: ReplayPruneSnapshot | undefined;
  let readStarted = false,
    removed = false;
  return {
    ...base,
    retentionPrune: {
      snapshot: (after) =>
        guard.operation(async () => {
          if (readStarted) throw new Error("Retention snapshot already read");
          readStarted = true;
          snapshot = structuredClone(await store.snapshot(after));
          return structuredClone(snapshot);
        }),
      remove: (selected) =>
        guard.operation(async () => {
          if (
            !snapshot ||
            removed ||
            selected.length < 1 ||
            selected.length > 100
          )
            throw new Error("Invalid retention deletion state");
          const keys = new Set<string>();
          for (const choice of selected) {
            const key = `${choice.kind}:${choice.id}`;
            if (keys.has(key)) throw new Error("Duplicate retention deletion");
            keys.add(key);
            const candidate = snapshot.candidates.find(
              (row) => row.kind === choice.kind && row.id === choice.id,
            );
            if (
              !candidate ||
              candidate.protected ||
              candidate.workspaceId !== base.workspaceId
            )
              throw new Error("Retention deletion is not eligible");
          }
          const expectedBytes = snapshot.candidates
            .filter((row) => keys.has(`${row.kind}:${row.id}`))
            .reduce((sum, row) => sum + row.bytes, 0);
          removed = true;
          const result = await store.remove(structuredClone(selected));
          if (
            result.deletedRows !== selected.length ||
            result.deletedBytes !== expectedBytes ||
            result.retainedBytes !== snapshot.retainedBytes - expectedBytes
          )
            throw new Error("Retention deletion/accounting mismatch");
          return result;
        }),
    },
  };
}
