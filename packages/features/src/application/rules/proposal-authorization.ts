import { RuleRequestError } from "./request-error.js";
import { createHash } from "node:crypto";
import { hasCapability } from "../../contracts/identity.js";
import {
  ruleProposalSchema,
  ruleProposalClaimSchema,
  type RuleProposal,
  type RuleProposalClaim,
} from "../../contracts/rule-proposal.js";
import {
  storedRuleReplaySnapshotSchema,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import { modelProfileSchema } from "../../contracts/model-profile.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleProposalTransaction } from "./proposal-ports.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function loadRuleProposalSource(
  tx: RuleProposalTransaction,
  id: string,
): Promise<StoredRuleReplaySnapshot> {
  const raw = await tx.replay.snapshot(id);
  if (!raw) throw new PersistenceError("not_found");
  const source = storedRuleReplaySnapshotSchema.parse(raw);
  if (
    source.workspaceId !== tx.workspaceId ||
    source.snapshot.snapshotId !== id
  )
    throw new PersistenceError("scope_violation");
  if (
    source.snapshot.evaluation ||
    source.snapshot.candidateEvaluation ||
    !source.snapshot.retained ||
    hash(source.snapshot) !== source.inputHash
  )
    throw new RuleRequestError(
      "PRECONDITION_FAILED",
      "Proposal requires an intact original retained capture",
    );
  return source;
}
export async function lockRuleProposalGeneration(
  tx: RuleProposalTransaction,
  input: RuleProposalClaim,
) {
  const row = await tx.proposals.lock(input.proposalId);
  if (!row) return undefined;
  const proposal = ruleProposalSchema.parse(row);
  if (
    proposal.workspaceId !== tx.workspaceId ||
    proposal.id !== input.proposalId
  )
    throw new PersistenceError("scope_violation");
  const claim = await tx.proposals.lockClaim(input);
  if (!claim) return undefined;
  const actual = ruleProposalClaimSchema.parse(claim);
  if (
    actual.workspaceId !== tx.workspaceId ||
    actual.proposalId !== proposal.id ||
    actual.runtimeId !== input.runtimeId ||
    actual.token !== input.token
  )
    throw new PersistenceError("scope_violation");
  return proposal.status === "generating" ? proposal : undefined;
}
export async function ruleProposalModelProfile(
  tx: RuleProposalTransaction,
  row: RuleProposal,
  source: StoredRuleReplaySnapshot,
) {
  const responder = await tx.responders.get(row.requestedBy),
    profileRaw = await tx.proposals.profile(row.profileId);
  if (
    !responder?.enabled ||
    responder.workspaceId !== tx.workspaceId ||
    responder.id !== row.requestedBy ||
    !hasCapability(responder.role, "rule:propose") ||
    !profileRaw
  )
    return undefined;
  const profile = modelProfileSchema.parse(profileRaw),
    d = source.snapshot.version.definition;
  const allowed =
    profile.id === row.profileId &&
    profile.revision === row.profileRevision &&
    profile.scope.workspaceId === tx.workspaceId &&
    profile.scope.serviceId === d.serviceId &&
    profile.scope.environmentId === d.environmentId &&
    JSON.stringify(profile.destination) === JSON.stringify(row.destination);
  return allowed ? profile : undefined;
}

/** Host profile/credential readers call this inside their bounded proposal
 * transaction; its live lease is fenced again by the repository before commit. */
export async function authorizeRuleProposalModel(
  tx: RuleProposalTransaction,
  raw: RuleProposalClaim,
) {
  const claim = ruleProposalClaimSchema.parse(raw),
    row = await lockRuleProposalGeneration(tx, claim);
  if (
    !row ||
    compareUtcTimestamps(await tx.proposals.currentTime(), row.expiresAt) >= 0
  )
    return undefined;
  const source = await loadRuleProposalSource(tx, row.sourceSnapshotId);
  if (source.inputHash !== row.sourceInputHash)
    throw new RuleRequestError("CONFLICT", "Proposal capture changed");
  return ruleProposalModelProfile(tx, row, source);
}
