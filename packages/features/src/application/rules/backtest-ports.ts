import type {
  WorkspaceId,
  RuleReplayChunk,
  RuleReplaySnapshot,
  IncidentLabel,
  RuleBacktestRecord,
} from "../../contracts/index.js";
import type { RuleReplayTransaction } from "./replay-ports.js";
export interface RuleBacktestStore {
  /** Sorted bounded chunks, read only after locking the completed run. */
  chunks(runId: string): Promise<RuleReplayChunk[]>;
  /** Reviewed, scoped, overlapping labels, available by snapshot.snapshotAt.
   * Throw on >1000 rows: truncation must never inflate reported precision. */
  labels(snapshot: RuleReplaySnapshot): Promise<IncidentLabel[]>;
  get(runId: string): Promise<RuleBacktestRecord | undefined>;
  insert(row: RuleBacktestRecord): Promise<void>;
}
export interface RuleBacktestTransaction extends RuleReplayTransaction {
  reports: RuleBacktestStore;
}
export interface RuleBacktestRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleBacktestTransaction) => Promise<T>,
  ): Promise<T>;
}
