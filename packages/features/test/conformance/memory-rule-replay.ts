import type { WorkspaceId } from "../../src/contracts/identity.js";
import type {
  RuleReplayRun,
  StoredRuleReplaySnapshot,
  RuleReplayChunk,
} from "../../src/contracts/replay-run.js";
import type {
  RuleReplayRepository,
  RuleReplayTransaction,
} from "../../src/application/rules/replay-ports.js";
import { withRuleReplay } from "../../src/application/rules/replay-transaction.js";
import { MemoryFoundationRepository } from "./memory.js";
type State = {
  runs: RuleReplayRun[];
  snapshots: StoredRuleReplaySnapshot[];
  chunks: RuleReplayChunk[];
};
export class MemoryRuleReplayRepository implements RuleReplayRepository {
  readonly foundation: MemoryFoundationRepository;
  failNextJob = false;
  expireOnSave = false;
  conflict = false;
  constructor(private readonly clock: () => Date) {
    this.foundation = new MemoryFoundationRepository({ now: clock });
  }
  async seed(row: RuleReplayRun, snapshot: StoredRuleReplaySnapshot) {
    await this.foundation.withExtensions(
      row.workspaceId,
      async (_base, extensions) => {
        const data = (extensions.replay ??= {
          runs: [],
          snapshots: [],
          chunks: [],
        }) as State;
        data.runs.push(structuredClone(row));
        data.snapshots.push(structuredClone(snapshot));
      },
    );
  }
  async state(scope: WorkspaceId) {
    return this.foundation.withExtensions(scope, async (_base, extensions) =>
      structuredClone(extensions.replay as State),
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleReplayTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(
      scope,
      async (base, extensions, guard) => {
        const data = (extensions.replay ??= {
          runs: [],
          snapshots: [],
          chunks: [],
        }) as State;
        let expired = false;
        const decorated = {
          ...base,
          work: {
            ...base.work,
            enqueue: (...args: Parameters<typeof base.work.enqueue>) =>
              guard.operation(() => {
                if (this.failNextJob)
                  throw new Error("Injected next-job failure");
                return base.work.enqueue(...args);
              }),
          },
        };
        return work(
          withRuleReplay(
            decorated,
            {
              currentTime: async () =>
                new Date(
                  this.clock().getTime() + (expired ? 3600000 : 0),
                ).toISOString(),
              lock: async (id) =>
                structuredClone(
                  data.runs.find((r) => r.workspaceId === scope && r.id === id),
                ),
              snapshot: async (id) =>
                structuredClone(
                  data.snapshots.find(
                    (r) =>
                      r.workspaceId === scope && r.snapshot.snapshotId === id,
                  ),
                ),
              append: async (row) => {
                if (
                  data.chunks.some(
                    (c) =>
                      c.workspaceId === scope &&
                      c.runId === row.runId &&
                      c.batch === row.batch,
                  )
                )
                  throw new Error("Duplicate chunk");
                data.chunks.push(structuredClone(row));
              },
              save: async (row, expected) => {
                const i = data.runs.findIndex(
                  (r) =>
                    r.workspaceId === scope &&
                    r.id === row.id &&
                    r.revision === expected,
                );
                if (i < 0 || this.conflict) return false;
                data.runs[i] = structuredClone(row);
                expired = this.expireOnSave;
                return true;
              },
            },
            guard,
          ),
        );
      },
    );
  }
}
