import type { DetectionTransaction } from "../../src/application/detection/ports.js";
import { withLiveRules } from "../../src/application/rules/live-transaction.js";
import type {
  WorkspaceId,
  RuleLiveRecord,
  RuleTransition,
  RuleHistoryQuery,
  RuleHistorySnapshot,
} from "../../src/contracts/index.js";
import type {
  RuleLiveRepository,
  RuleLiveTransaction,
} from "../../src/application/rules/live-ports.js";
import { MemoryDetectionRepository } from "./memory-detection.js";
type State = {
  rows: RuleLiveRecord[];
  decisions: {
    scope: WorkspaceId;
    ruleId: string;
    generation: number;
    transition: RuleTransition;
  }[];
};
/** Reuses the foundation's transactional clone/guard rather than side maps that
 * could commit independently of page/outbox state. */
export class MemoryRuleLiveRepository implements RuleLiveRepository {
  readonly detection: MemoryDetectionRepository;
  known = true;
  enabled = true;
  maintenance = false;
  failNextJob = false;
  history: (
    scope: WorkspaceId,
    query: RuleHistoryQuery,
  ) => Promise<RuleHistorySnapshot> = async () => {
    throw new Error("Missing fixture history");
  };
  constructor(clock: () => Date) {
    this.detection = new MemoryDetectionRepository(clock);
  }
  async seed(row: RuleLiveRecord) {
    await this.detection.withExtensions(
      row.version.definition.workspaceId,
      async (_tx, extensions) => {
        const data = (extensions.ruleLive ??= {
          rows: [],
          decisions: [],
        }) as State;
        if (
          data.rows.some(
            (r) =>
              r.version.id === row.version.id &&
              r.version.definition.workspaceId ===
                row.version.definition.workspaceId,
          )
        )
          throw new Error("Duplicate fixture rule");
        data.rows.push(structuredClone(row));
      },
    );
  }
  async decisions(scope: WorkspaceId) {
    return this.detection.withExtensions(scope, async (_tx, extensions) =>
      structuredClone(
        (
          (extensions.ruleLive ?? { rows: [], decisions: [] }) as State
        ).decisions.filter((row) => row.scope === scope),
      ),
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleLiveTransaction) => Promise<T>,
  ): Promise<T> {
    return this.detection.withExtensions(
      scope,
      async (base, extensions, guard) => {
        const data = (extensions.ruleLive ??= {
          rows: [],
          decisions: [],
        }) as State;
        const decoratedBase: DetectionTransaction = {
          ...base,
          work: {
            ...base.work,
            enqueue: (queue, input) =>
              guard.operation(() => {
                if (this.failNextJob && input.kind === "rules.evaluate")
                  throw new Error("Injected next-job failure");
                return base.work.enqueue(queue, input);
              }),
          },
        };
        return work(
          withLiveRules(
            decoratedBase,
            {
              lock: (id) =>
                guard.operation(() =>
                  structuredClone(
                    data.rows.find(
                      (row) =>
                        row.version.id === id &&
                        row.version.definition.workspaceId === scope,
                    ),
                  ),
                ),
              history: (query) =>
                guard.operation(() => this.history(scope, query)),
              policy: () =>
                guard.operation(() => ({
                  known: this.known,
                  enabled: this.enabled,
                  maintenance: this.maintenance,
                })),
              save: (row, expected) =>
                guard.operation(() => {
                  if (row.version.definition.workspaceId !== scope)
                    throw new Error("Scope violation");
                  const index = data.rows.findIndex(
                    (r) =>
                      r.version.id === row.version.id &&
                      r.version.definition.workspaceId === scope,
                  );
                  if (index < 0 || data.rows[index]!.revision !== expected)
                    return false;
                  data.rows[index] = structuredClone(row);
                  return true;
                }),
              decision: (row, transition) =>
                guard.operation(() => {
                  if (
                    data.decisions.some(
                      (r) =>
                        r.scope === scope &&
                        r.ruleId === row.version.id &&
                        r.generation === row.generation &&
                        r.transition.state.lastDecisionAt ===
                          transition.state.lastDecisionAt,
                    )
                  )
                    throw new Error("Duplicate decision");
                  data.decisions.push(
                    structuredClone({
                      scope,
                      ruleId: row.version.id,
                      generation: row.generation,
                      transition,
                    }),
                  );
                }),
            },
            guard,
          ),
        );
      },
    );
  }
}
