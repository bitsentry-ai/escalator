import type {
  WorkspaceId,
  RuleLiveRecord,
  RuleTransition,
  RuleHistoryQuery,
  RuleHistorySnapshot,
} from "../../contracts/index.js";
import type { DetectionTransaction } from "../detection/ports.js";
export interface RuleLiveTransaction extends DetectionTransaction {
  rules: {
    /** Lock the source/configuration scope before the runtime row; all write paths
     * must use that order. The caller then locks the existing page and work claim. */
    lock(id: string): Promise<RuleLiveRecord | undefined>;
    /** Reads on this physical transaction, never another pool connection. */
    history(query: RuleHistoryQuery): Promise<RuleHistorySnapshot>;
    /** Historical policy known at decisionAt, not inferred from today's settings. */
    policy(
      row: RuleLiveRecord,
      decisionAt: string,
    ): Promise<{
      known: boolean;
      enabled: boolean;
      maintenance: boolean;
      pagingEnabled?: boolean;
    }>;
    save(row: RuleLiveRecord, expectedRevision: number): Promise<boolean>;
    /** Immutable receipt; unique per (workspace, rule, generation, decisionAt). */
    decision(row: RuleLiveRecord, transition: RuleTransition): Promise<void>;
  };
}
export interface RuleLiveRepository {
  /** One bounded PostgreSQL transaction; all failures (even caught primitive
   * failures) poison it. Runtime, decision, paging, audit and next job are atomic. */
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleLiveTransaction) => Promise<T>,
  ): Promise<T>;
}
