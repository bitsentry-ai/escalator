import { ruleBacktestJobSchema } from "../../contracts/backtest-record.js";
import { ruleBacktestJobId } from "./backtest-job.js";
import { opaqueIdSchema } from "../../contracts/identity.js";
import {
  ruleReplayRunSchema,
  ruleReplayChunkSchema,
  storedRuleReplaySnapshotSchema,
  type RuleReplayRun,
  type RuleReplayChunk,
} from "../../contracts/replay-run.js";
import {
  PersistenceError,
  type FoundationTransaction,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { RuleReplayStore, RuleReplayTransaction } from "./replay-ports.js";
/** Wrap host primitives once: a batch cannot silently change its immutable
 * input or advance the cursor independently of the persisted decisions. */
export function withRuleReplay<T extends FoundationTransaction>(
  base: T,
  store: RuleReplayStore,
  guard: TransactionGuard,
): T & RuleReplayTransaction {
  const locked = new Map<string, RuleReplayRun>();
  const chunks = new Map<string, RuleReplayChunk>();
  const scope = (value: { workspaceId: string }) => {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  return {
    ...base,
    work: {
      ...base.work,
      enqueue: (queue, intent) =>
        guard.operation(() => {
          if (queue === "job" && intent.kind === "rules.backtest") {
            const { runId } = ruleBacktestJobSchema.parse(intent.payload);
            const row = locked.get(runId),
              id = ruleBacktestJobId(base.workspaceId, runId);
            if (
              !row ||
              row.status !== "completed" ||
              intent.id !== id ||
              intent.idempotencyKey !== id
            )
              throw new Error("Report requires a locked completed replay");
            return base.work.enqueue(queue, intent);
          }
          if (queue !== "job" || intent.kind !== "rules.replay")
            throw new Error("Replay can enqueue only replay jobs");
          return base.work.enqueue(queue, intent);
        }),
      cancel: () =>
        guard.operation(() => {
          throw new Error("Replay execution cannot cancel work");
        }),
    },
    replay: {
      currentTime: () => guard.operation(() => store.currentTime()),
      lock: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.lock(id);
          if (!raw) return undefined;
          const row = ruleReplayRunSchema.parse(raw);
          scope(row);
          if (row.id !== id) throw new PersistenceError("scope_violation");
          locked.set(id, structuredClone(row));
          return row;
        }),
      snapshot: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.snapshot(id);
          if (!raw) return undefined;
          const row = storedRuleReplaySnapshotSchema.parse(raw);
          scope(row);
          if (row.snapshot.snapshotId !== id)
            throw new PersistenceError("scope_violation");
          return row;
        }),
      append: (raw) =>
        guard.operation(async () => {
          const row = ruleReplayChunkSchema.parse(raw);
          scope(row);
          const prior = locked.get(row.runId);
          if (
            !prior ||
            chunks.has(row.runId) ||
            prior.snapshotId !== row.snapshotId ||
            prior.nextBatch !== row.batch ||
            (prior.status !== "queued" && prior.status !== "running")
          )
            throw new Error("Replay chunk conflict");
          await store.append(row);
          chunks.set(row.runId, structuredClone(row));
        }),
      save: (raw, expected) =>
        guard.operation(async () => {
          const row = ruleReplayRunSchema.parse(raw);
          scope(row);
          const prior = locked.get(row.id),
            chunk = chunks.get(row.id);
          if (
            !prior ||
            !chunk ||
            prior.revision !== expected ||
            row.revision !== expected + 1 ||
            row.nextBatch !== prior.nextBatch + 1 ||
            row.snapshotId !== prior.snapshotId ||
            row.inputHash !== prior.inputHash ||
            row.createdAt !== prior.createdAt ||
            (row.status !== "running" && row.status !== "completed") ||
            row.decisionCount !==
              prior.decisionCount + chunk.decisions.length ||
            JSON.stringify(row.cursor?.state) !==
              JSON.stringify(chunk.decisions[chunk.decisions.length - 1].state)
          )
            throw new Error("Replay revision conflict");
          const accepted = await store.save(row, expected);
          if (accepted) {
            locked.set(row.id, structuredClone(row));
            chunks.delete(row.id);
          }
          return accepted;
        }),
    },
  };
}
