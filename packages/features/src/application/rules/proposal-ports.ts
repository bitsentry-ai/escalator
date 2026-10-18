import type {
  WorkspaceId,
  IncidentLabel,
  ModelProfile,
} from "../../contracts/index.js";
import type {
  RuleProposal,
  RuleProposalClaim,
} from "../../contracts/rule-proposal.js";
import type { RuleReplayCaptureTransaction } from "./replay-capture.js";
import type { RuleBacktestTransaction } from "./backtest-ports.js";
export interface RuleProposalStore {
  /** Lock proposal before its work/claim row. */
  lock(id: string): Promise<RuleProposal | undefined>;
  /** Database time, fresh within the bounded transaction. */
  currentTime(): Promise<string>;
  /** Serialize workspace quota (at most three nonterminal proposals), reject duplicates,
   * and enqueue ruleProposalGenerationJob(row) atomically. */
  insert(row: RuleProposal): Promise<void>;
  /** CAS and immutable identity/source/candidate binding. Poison transaction on errors. */
  save(row: RuleProposal, expectedRevision: number): Promise<boolean>;
  /** Scope-checked current records, never caller-supplied authorization. */
  label(id: string): Promise<IncidentLabel | undefined>;
  /** Return only a currently enabled profile; disabled/missing settings are unavailable. */
  profile(id: string): Promise<ModelProfile | undefined>;
  /** Check persisted runtime/token/unexpired deadline/attempt; request expiry is not authority.
   * The adapter must fence the claim again before COMMIT, including a monotonic deadline. */
  lockClaim(claim: RuleProposalClaim): Promise<RuleProposalClaim | undefined>;
  /** Publish next evaluation job in this transaction; derive kind/id from the locked
   * saved proposal. No arbitrary job payload is accepted. */
  scheduleEvaluation(row: RuleProposal): Promise<void>;
  /** Settle the generation job and invalidate its claim on finish, failure or cancellation. */
  releaseClaim(id: string): Promise<void>;
}
export interface RuleProposalTransaction
  extends RuleReplayCaptureTransaction, RuleBacktestTransaction {
  proposals: RuleProposalStore;
}
export interface RuleProposalRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleProposalTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Host claim operation commits before any model I/O. Reclaim only expired leases;
 * max three attempts, bounded DB deadline, no live-lease stealing. */
export interface RuleProposalClaims {
  claim(input: {
    workspaceId: WorkspaceId;
    runtimeId: string;
    token: string;
  }): Promise<RuleProposalClaim | undefined>;
  heartbeat(claim: RuleProposalClaim): Promise<boolean>;
}
