import type { WorkspaceId } from "../../contracts/identity.js";
import type {
  RuleReplayRun,
  StoredRuleReplaySnapshot,
  RuleReplayChunk,
} from "../../contracts/replay-run.js";
import type { FoundationTransaction } from "../ports/persistence.js";
/** No paging, outbox provider or rule activation primitives are exposed here.
 * All methods share the surrounding tenant transaction and poison it on error. */
export interface RuleReplayStore {
  currentTime(): Promise<string>;
  /** Run row is always locked before the durable work claim. */
  lock(id: string): Promise<RuleReplayRun | undefined>;
  snapshot(id: string): Promise<StoredRuleReplaySnapshot | undefined>;
  /** Immutable unique (tenant,run,batch); conflicts must not overwrite. */
  append(chunk: RuleReplayChunk): Promise<void>;
  save(row: RuleReplayRun, expectedRevision: number): Promise<boolean>;
}
export interface RuleReplayTransaction extends FoundationTransaction {
  replay: RuleReplayStore;
}
export interface RuleReplayRepository {
  /** Bounded callback with cursor/chunk/next job/audit committing together.
   * Capture transactions must enforce a 16 MiB encoded snapshot ceiling. */
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleReplayTransaction) => Promise<T>,
  ): Promise<T>;
}
