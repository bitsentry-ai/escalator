import type {
  WorkspaceId,
  RuleLiveRecord,
  DetectionRuleVersion,
  RuleBacktestRecord,
} from "../../contracts/index.js";
import type {
  RuleCatalogEntry,
  RuleReviewReceipt,
  RuleReviewFingerprint,
  RuleActivationHistory,
} from "../../contracts/rule-catalog.js";
import type { FoundationTransaction } from "../ports/persistence.js";
/** All methods run on the surrounding tenant transaction. Lock the source and
 * configuration scope before catalog/runtime, then work. A failed primitive
 * poisons the transaction, including errors a caller attempts to catch. */
export interface RuleCatalogStore {
  currentTime(): Promise<string>;
  /** Validate and lock a new draft's source scope using the live evaluator order. */
  lockDefinition(version: DetectionRuleVersion): Promise<void>;
  lock(ruleId: string): Promise<RuleCatalogEntry | undefined>;
  version(
    ruleId: string,
    revision: number,
  ): Promise<DetectionRuleVersion | undefined>;
  latestVersionRevision(ruleId: string): Promise<number>;
  insert(entry: RuleCatalogEntry, version: DetectionRuleVersion): Promise<void>;
  insertVersion(version: DetectionRuleVersion): Promise<void>;
  save(entry: RuleCatalogEntry, expectedRevision: number): Promise<boolean>;
  runtime(ruleId: string): Promise<RuleLiveRecord | undefined>;
  /** Retire then replace on a fresh generation, with no old state or incident.
   * Retiring a rule never acknowledges or resolves its historical incidents. */
  retireRuntime(ruleId: string): Promise<void>;
  activateRuntime(row: RuleLiveRecord): Promise<void>;
  review(id: string): Promise<RuleReviewReceipt | undefined>;
  insertReview(receipt: RuleReviewReceipt): Promise<void>;
  history(row: RuleActivationHistory): Promise<void>;
  /** Recompute under the same source/configuration locks. Active reviews require
   * a completed, immutable report and its original capture. Hashes exclude only
   * read-clock metadata, never coverage facts. No caller-provided fingerprints.
   * An AI-origin rule must also validate its full/held-out report seals. */
  evidence(
    entry: RuleCatalogEntry,
    version: DetectionRuleVersion,
    runId: string | null,
  ): Promise<{
    fingerprint: RuleReviewFingerprint;
    report: RuleBacktestRecord | null;
    measurementHash: string;
    policyKnown: boolean;
    policyEnabled: boolean;
  }>;
}
export interface RuleCatalogTransaction extends FoundationTransaction {
  catalog: RuleCatalogStore;
}
export interface RuleCatalogRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleCatalogTransaction) => Promise<T>,
  ): Promise<T>;
}
