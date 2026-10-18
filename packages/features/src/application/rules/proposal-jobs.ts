import {
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import type { WorkIntent } from "../jobs/ports.js";
import { pagingWorkId } from "../paging/work-ids.js";
/** Both hosts use the same job identities. Adapters enqueue these through the
 * original foundation writer within the proposal transaction, never Bull. */
export function ruleProposalGenerationJob(raw: RuleProposal): WorkIntent {
  const row = ruleProposalSchema.parse(raw);
  if (row.status !== "queued" || row.revision !== 1)
    throw new Error("Generation requires a new proposal");
  return {
    id: row.id,
    kind: "rules.propose",
    idempotencyKey: row.id,
    payload: { proposalId: row.id },
    dueAt: row.createdAt,
  };
}
export function ruleProposalEvaluationJob(raw: RuleProposal): WorkIntent {
  const row = ruleProposalSchema.parse(raw);
  if (row.status !== "evaluating")
    throw new Error("Evaluation requires a generated candidate");
  const id = ruleProposalEvaluationJobId(row.workspaceId, row.id, row.revision);
  return {
    id,
    kind: "rules.proposal-evaluate",
    idempotencyKey: id,
    payload: { proposalId: row.id, revision: row.revision },
    dueAt: row.updatedAt,
  };
}

export function ruleProposalEvaluationJobId(
  scope: RuleProposal["workspaceId"],
  proposalId: string,
  revision: number,
): string {
  return pagingWorkId(
    scope,
    "rule-proposal-evaluation",
    proposalId,
    String(revision),
  );
}
