import { createHash } from "node:crypto";
import { hasCapability, type Actor } from "../../contracts/identity.js";
import {
  ruleProposalSchema,
  ruleProposalRequestSchema,
  ruleProposalClaimSchema,
  ruleCandidateResultSchema,
  type RuleProposal,
  type RuleProposalClaim,
} from "../../contracts/rule-proposal.js";
import {
  storedRuleReplaySnapshotSchema,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import { incidentLabelSchema } from "../../contracts/rule-label.js";
import { modelProfileSchema } from "../../contracts/model-profile.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { planRuleTuning } from "./tuning.js";
import { redactEvidence } from "../../investigation/evidence/redaction.js";
import type {
  RuleProposalRepository,
  RuleProposalTransaction,
} from "./proposal-ports.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (row: RuleProposal) =>
  ["ready", "failed", "cancelled"].includes(row.status);
async function sourceFor(
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
    throw new Error("Proposal requires an intact original retained capture");
  return source;
}
async function authorize(tx: RuleProposalTransaction, actor: Actor) {
  const responder = await tx.responders.get(actor.responderId);
  if (
    actor.workspaceId !== tx.workspaceId ||
    !responder?.enabled ||
    responder.workspaceId !== tx.workspaceId ||
    responder.id !== actor.responderId ||
    responder.role !== actor.role ||
    !hasCapability(responder.role, "rule:propose")
  )
    throw new Error("Rule proposal forbidden");
}
async function audit(
  tx: RuleProposalTransaction,
  row: RuleProposal,
  action: string,
  actor?: Actor,
) {
  await tx.audit.append({
    id: pagingWorkId(
      tx.workspaceId,
      "rule-proposal-audit",
      row.id,
      String(row.revision),
    ),
    workspaceId: tx.workspaceId,
    actor: actor
      ? { kind: "responder", responderId: actor.responderId }
      : { kind: "system", component: "rule-proposal" },
    action,
    subjectType: "rule-proposal",
    subjectId: row.id,
    recordedAt: row.updatedAt,
    metadata: {
      sourceSnapshotId: row.sourceSnapshotId,
      candidateId: row.candidateId,
      status: row.status,
    },
  });
}
async function save(
  tx: RuleProposalTransaction,
  previous: RuleProposal,
  next: RuleProposal,
  action: string,
  actor?: Actor,
) {
  const parsed = ruleProposalSchema.parse(next);
  if (!(await tx.proposals.save(parsed, previous.revision)))
    throw new Error("Proposal changed concurrently");
  await audit(tx, parsed, action, actor);
  return parsed;
}
async function activeClaim(
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
async function fail(
  tx: RuleProposalTransaction,
  row: RuleProposal,
  failure: NonNullable<RuleProposal["failure"]>,
  now: string,
) {
  const next = await save(
    tx,
    row,
    {
      ...row,
      status: "failed",
      failure,
      revision: row.revision + 1,
      updatedAt: now,
    },
    "rule.proposal_failed",
  );
  await tx.proposals.releaseClaim(row.id);
  return next;
}
async function permitted(
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
    return false;
  const profile = modelProfileSchema.parse(profileRaw),
    d = source.snapshot.version.definition;
  return (
    profile.id === row.profileId &&
    profile.revision === row.profileRevision &&
    profile.scope.workspaceId === tx.workspaceId &&
    profile.scope.serviceId === d.serviceId &&
    profile.scope.environmentId === d.environmentId &&
    JSON.stringify(profile.destination) === JSON.stringify(row.destination)
  );
}
/** Generation never holds a database transaction open across model I/O. The
 * pending row is not reviewable; only later report attachment can make it ready. */
export class RuleProposalGeneration {
  constructor(private readonly repository: RuleProposalRepository) {}
  request(actor: Actor, raw: unknown): Promise<RuleProposal> {
    const input = ruleProposalRequestSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const source = await sourceFor(tx, input.sourceSnapshotId),
        d = source.snapshot.version.definition;
      const id = pagingWorkId(
        tx.workspaceId,
        "rule-proposal",
        input.sourceSnapshotId,
      );
      const existing = await tx.proposals.lock(id);
      if (existing) {
        const row = ruleProposalSchema.parse(existing);
        if (row.workspaceId !== tx.workspaceId || row.id !== id)
          throw new PersistenceError("scope_violation");
        if (
          row.sourceInputHash !== source.inputHash ||
          row.requestedBy !== actor.responderId ||
          row.originLabelId !== input.originLabelId ||
          row.profileId !== input.profileId
        )
          throw new Error("A different proposal already uses this capture");
        return row;
      }
      const labelRaw = await tx.proposals.label(input.originLabelId),
        profileRaw = await tx.proposals.profile(input.profileId);
      if (!labelRaw || !profileRaw) throw new PersistenceError("not_found");
      const label = incidentLabelSchema.parse(labelRaw),
        profile = modelProfileSchema.parse(profileRaw);
      if (
        label.workspaceId !== tx.workspaceId ||
        label.id !== input.originLabelId ||
        label.serviceId !== d.serviceId ||
        label.environmentId !== d.environmentId ||
        label.stream.kind !== d.selector.kind ||
        label.stream.id !== d.selector.streamId ||
        profile.id !== input.profileId ||
        profile.scope.workspaceId !== tx.workspaceId ||
        profile.scope.serviceId !== d.serviceId ||
        profile.scope.environmentId !== d.environmentId
      )
        throw new PersistenceError("scope_violation");
      if (
        label.status !== "reviewed" ||
        !label.reviewedAt ||
        compareUtcTimestamps(label.reviewedAt, source.snapshot.snapshotAt) >
          0 ||
        compareUtcTimestamps(label.endedAt, source.snapshot.firstDecisionAt) <=
          0 ||
        compareUtcTimestamps(label.startedAt, source.snapshot.lastDecisionAt) >
          0
      )
        throw new Error("Proposal origin must be reviewed before capture");
      const now = await tx.proposals.currentTime();
      if (compareUtcTimestamps(source.snapshot.snapshotAt, now) > 0)
        throw new Error("Capture is in the future");
      const row = ruleProposalSchema.parse({
        id,
        workspaceId: tx.workspaceId,
        requestedBy: actor.responderId,
        originLabelId: label.id,
        sourceSnapshotId: input.sourceSnapshotId,
        sourceInputHash: source.inputHash,
        candidateId: pagingWorkId(tx.workspaceId, "rule-candidate", id),
        profileId: profile.id,
        profileRevision: profile.revision,
        destination: profile.destination,
        revision: 1,
        status: "queued",
        generation: null,
        failure: null,
        fullRunId: null,
        heldOutRunId: null,
        heldOut: planRuleTuning(source.snapshot).heldOut
          ? "required"
          : "insufficient_span",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
      });
      await tx.proposals.insert(row);
      await audit(tx, row, "rule.proposal_requested", actor);
      return row;
    });
  }
  prepare(raw: RuleProposalClaim) {
    const claim = ruleProposalClaimSchema.parse(raw);
    return this.repository.transaction(claim.workspaceId, async (tx) => {
      const row = await activeClaim(tx, claim);
      if (!row) return undefined;
      const now = await tx.proposals.currentTime();
      if (compareUtcTimestamps(now, row.expiresAt) >= 0) {
        await fail(tx, row, "expired", now);
        return undefined;
      }
      const source = await sourceFor(tx, row.sourceSnapshotId);
      if (source.inputHash !== row.sourceInputHash)
        throw new Error("Proposal capture changed");
      if (!(await permitted(tx, row, source))) {
        await fail(tx, row, "authorization_changed", now);
        return undefined;
      }
      const labels = await tx.reports.labels(source.snapshot);
      return {
        source,
        labels,
        profileId: row.profileId,
        candidateId: row.candidateId,
      };
    });
  }
  complete(raw: RuleProposalClaim, result: unknown): Promise<boolean> {
    const claim = ruleProposalClaimSchema.parse(raw),
      generation = ruleCandidateResultSchema.parse(result);
    return this.repository.transaction(claim.workspaceId, async (tx) => {
      const row = await activeClaim(tx, claim);
      if (!row) return false;
      const now = await tx.proposals.currentTime();
      if (compareUtcTimestamps(now, row.expiresAt) >= 0) {
        await fail(tx, row, "expired", now);
        return false;
      }
      const source = await sourceFor(tx, row.sourceSnapshotId);
      if (!(await permitted(tx, row, source))) {
        await fail(tx, row, "authorization_changed", now);
        return false;
      }
      const original = source.snapshot.version.definition,
        candidate = generation.candidate;
      // Only tuning parameters may differ. Scope/source/severity/evaluator/cadence remain fixed.
      const variable = new Set([
        "aggregation",
        "windowSeconds",
        "minimumSamples",
        "trigger",
        "recovery",
        "persistenceSeconds",
        "recoverySeconds",
        "cooldownSeconds",
      ]);
      for (const key of [
        ...new Set([
          ...Object.keys(original),
          ...Object.keys(candidate.definition),
        ]),
      ] as (keyof typeof original)[])
        if (
          !variable.has(key) &&
          JSON.stringify(original[key]) !==
            JSON.stringify(candidate.definition[key])
        )
          throw new Error("Candidate changed a fixed field");
      if (
        source.inputHash !== row.sourceInputHash ||
        generation.sourceInputHash !== row.sourceInputHash ||
        generation.sourceSnapshotId !== row.sourceSnapshotId ||
        candidate.id !== row.candidateId ||
        candidate.id === source.snapshot.version.id ||
        candidate.revision !== 1 ||
        generation.trainingCutoffAt !==
          planRuleTuning(source.snapshot).training.lastDecisionAt ||
        JSON.stringify(generation.destination) !==
          JSON.stringify(row.destination)
      )
        throw new Error("Candidate provenance mismatch");
      const next = await save(
        tx,
        row,
        {
          ...row,
          status: "evaluating",
          generation: {
            ...generation,
            rationale: redactEvidence(generation.rationale).text,
          },
          revision: row.revision + 1,
          updatedAt: now,
        },
        "rule.proposal_generated",
      );
      await tx.proposals.scheduleEvaluation(next);
      await tx.proposals.releaseClaim(row.id);
      return true;
    });
  }
  failed(raw: RuleProposalClaim): Promise<boolean> {
    const claim = ruleProposalClaimSchema.parse(raw);
    return this.repository.transaction(claim.workspaceId, async (tx) => {
      const row = await activeClaim(tx, claim);
      if (!row) return false;
      await fail(
        tx,
        row,
        "generation_failed",
        await tx.proposals.currentTime(),
      );
      return true;
    });
  }
  cancel(actor: Actor, id: string): Promise<RuleProposal> {
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const raw = await tx.proposals.lock(id);
      if (!raw) throw new PersistenceError("not_found");
      const row = ruleProposalSchema.parse(raw);
      if (row.workspaceId !== tx.workspaceId || row.id !== id)
        throw new PersistenceError("scope_violation");
      if (
        actor.role !== "administrator" &&
        row.requestedBy !== actor.responderId
      )
        throw new Error("Proposal cancellation forbidden");
      if (terminal(row)) return row;
      const next = await save(
        tx,
        row,
        {
          ...row,
          status: "cancelled",
          revision: row.revision + 1,
          updatedAt: await tx.proposals.currentTime(),
        },
        "rule.proposal_cancelled",
        actor,
      );
      await tx.proposals.releaseClaim(row.id);
      return next;
    });
  }
}
