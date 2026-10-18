import type { WorkspaceId } from "../../contracts/identity.js";
import type {
  RuleResultsList,
  RuleProposalsList,
  RuleReplayResult,
  RuleProposalView,
} from "../../contracts/rule-results.js";
import type { FoundationTransaction } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  RuleReportDetailInput,
  RuleReportDetail,
} from "../../contracts/rule-report-detail.js";
export interface RuleResultsStore {
  detail(input: RuleReportDetailInput): Promise<RuleReportDetail | undefined>;
  replays(input: RuleResultsList): Promise<RuleReplayResult[]>;
  replay(id: string): Promise<RuleReplayResult | undefined>;
  proposals(input: RuleProposalsList): Promise<RuleProposalView[]>;
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
      detail: (input) => guard.operation(() => store.detail(input)),
      replays: (input) => guard.operation(() => store.replays(input)),
      replay: (id) => guard.operation(() => store.replay(id)),
      proposals: (input) => guard.operation(() => store.proposals(input)),
      proposal: (id) => guard.operation(() => store.proposal(id)),
    },
  };
}
