import {
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import type { AuditEvent } from "../ports/audit.js";
import { pagingWorkId } from "../paging/work-ids.js";
/** Shared status/audit policy for host-owned committed lease adapters. All times
 * come from a fresh database clock after locking the proposal and its job. */
export function transitionRuleProposalClaim(
  raw: RuleProposal,
  databaseNow: string,
  outcome: "claimed" | "expired" | "exhausted" | "abandoned",
): { row: RuleProposal; audit: AuditEvent } {
  const row = ruleProposalSchema.parse(raw),
    now = utcTimestampSchema.parse(databaseNow);
  if (
    !["queued", "generating"].includes(row.status) ||
    compareUtcTimestamps(now, row.updatedAt) < 0
  )
    throw new Error("Invalid proposal claim transition");
  if (outcome === "claimed" && compareUtcTimestamps(now, row.expiresAt) >= 0)
    throw new Error("Proposal expired before claim");
  if (outcome === "expired" && compareUtcTimestamps(now, row.expiresAt) < 0)
    throw new Error("Proposal has not expired");
  const next = ruleProposalSchema.parse({
    ...row,
    revision: row.revision + 1,
    updatedAt: now,
    status: outcome === "claimed" ? "generating" : "failed",
    failure:
      outcome === "claimed"
        ? null
        : outcome === "expired"
          ? "expired"
          : "generation_failed",
  });
  const audit: AuditEvent = {
    id: pagingWorkId(
      row.workspaceId,
      "rule-proposal-claim",
      row.id,
      String(next.revision),
    ),
    workspaceId: row.workspaceId,
    actor: { kind: "system", component: "rules.proposal-claims" },
    action:
      outcome === "claimed" ? "rule.proposal_claimed" : "rule.proposal_failed",
    subjectType: "rule_proposal",
    subjectId: row.id,
    recordedAt: now,
    metadata: { revision: next.revision, outcome },
  };
  return { row: next, audit };
}

export interface RuleProposalClaimJobState {
  state: string;
  attempt: number;
  dueAt: string;
  leaseExpiresAt: string | null;
}
/** A live final attempt remains busy; attempt exhaustion is considered only
 * once its lease expires. Proposal expiry itself is an absolute deadline. */
export function ruleProposalClaimDisposition(
  raw: RuleProposal,
  job: RuleProposalClaimJobState | undefined,
  databaseNow: string,
): "busy" | "claimed" | "expired" | "exhausted" | "abandoned" {
  const row = ruleProposalSchema.parse(raw),
    now = utcTimestampSchema.parse(databaseNow);
  if (compareUtcTimestamps(now, row.expiresAt) >= 0) return "expired";
  if (!job || ["completed", "failed", "cancelled"].includes(job.state))
    return "abandoned";
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 0)
    throw new Error("Invalid generation attempt");
  if (job.state === "running") {
    if (!job.leaseExpiresAt)
      throw new Error("Running generation requires a lease");
    if (
      compareUtcTimestamps(utcTimestampSchema.parse(job.leaseExpiresAt), now) >
      0
    )
      return "busy";
  } else if (job.state === "pending") {
    if (compareUtcTimestamps(utcTimestampSchema.parse(job.dueAt), now) > 0)
      return "busy";
  } else throw new Error("Invalid generation job state");
  return job.attempt >= 3 ? "exhausted" : "claimed";
}
