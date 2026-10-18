import type { WorkspaceId } from "../../contracts/identity.js";
import type {
  RuleResultsList,
  RuleReplayResult,
  RuleProposalView,
} from "../../contracts/rule-results.js";
import type { FoundationTransaction } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
export interface RuleResultsStore {
  replays(input: RuleResultsList): Promise<RuleReplayResult[]>;
  replay(id: string): Promise<RuleReplayResult | undefined>;
  proposals(input: RuleResultsList): Promise<RuleProposalView[]>;
  proposal(id: string): Promise<RuleProposalView | undefined>;
}
export interface RuleResultsTransaction extends FoundationTransaction {
  ruleResults: RuleResultsStore;
}
export interface RuleResultsRepository {
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: RuleResultsTransaction) => Promise<T>,
  ): Promise<T>;
}
export function withRuleResults<T extends FoundationTransaction>(
  base: T,
  store: RuleResultsStore,
  guard: TransactionGuard,
): T & RuleResultsTransaction {
  return {
    ...base,
    ruleResults: {
      replays: (input) => guard.operation(() => store.replays(input)),
      replay: (id) => guard.operation(() => store.replay(id)),
      proposals: (input) => guard.operation(() => store.proposals(input)),
      proposal: (id) => guard.operation(() => store.proposal(id)),
    },
  };
}
