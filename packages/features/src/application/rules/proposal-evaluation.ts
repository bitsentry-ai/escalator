import {
  ruleProposalEvaluationJobSchema,
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import {
  ruleReplayRunSchema,
  storedRuleReplaySnapshotSchema,
  type RuleReplayRun,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type {
  RuleProposalRepository,
  RuleProposalTransaction,
} from "./proposal-ports.js";
import { ruleProposalEvaluationJobId } from "./proposal-jobs.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { deriveCandidateReplay } from "./candidate-replay.js";
import { deriveHeldOutReplay } from "./held-out.js";
import { enqueueRuleReplay, ruleReplayJobId } from "./replay-job.js";
import { ruleBacktestJobId } from "./backtest-job.js";
async function save(
  tx: RuleProposalTransaction,
  before: RuleProposal,
  next: RuleProposal,
  action: string,
): Promise<RuleProposal> {
  const row = ruleProposalSchema.parse(next);
  if (!(await tx.proposals.save(row, before.revision)))
    throw new Error("Proposal evaluation changed concurrently");
  await tx.audit.append({
    id: pagingWorkId(
      tx.workspaceId,
      "rule-proposal-audit",
      row.id,
      String(row.revision),
    ),
    workspaceId: tx.workspaceId,
    actor: { kind: "system", component: "rule-proposal-evaluation" },
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
  return row;
}
async function fail(
  tx: RuleProposalTransaction,
  row: RuleProposal,
  now: string,
  expired: boolean,
): Promise<WorkResult> {
  await save(
    tx,
    row,
    {
      ...row,
      status: "failed",
      failure: expired ? "expired" : "evaluation_failed",
      revision: row.revision + 1,
      updatedAt: now,
    },
    "rule.proposal_failed",
  );
  return { state: "completed" };
}
async function sourceFor(
  tx: RuleProposalTransaction,
  row: RuleProposal,
): Promise<StoredRuleReplaySnapshot> {
  const loaded = await tx.replay.snapshot(row.sourceSnapshotId);
  if (!loaded) throw new Error("Proposal capture unavailable");
  const source = storedRuleReplaySnapshotSchema.parse(loaded);
  if (
    source.workspaceId !== tx.workspaceId ||
    source.snapshot.snapshotId !== row.sourceSnapshotId ||
    source.inputHash !== row.sourceInputHash
  )
    throw new PersistenceError("scope_violation");
  return source;
}
async function startReplay(
  tx: RuleProposalTransaction,
  row: RuleProposal,
  heldOut: boolean,
  now: string,
): Promise<WorkResult> {
  if (!row.generation) throw new Error("Proposal candidate unavailable");
  const source = await sourceFor(tx, row);
  const stored = heldOut
    ? deriveHeldOutReplay(source, row.generation.candidate)
    : deriveCandidateReplay(source, row.generation.candidate);
  // The held-out slot is shared with the existing sealed-evaluation use case.
  const id = pagingWorkId(
    tx.workspaceId,
    heldOut ? "rule-held-out-run" : "rule-proposal-full-run",
    row.sourceSnapshotId,
  );
  const prior = await tx.replay.lock(id);
  let run: RuleReplayRun;
  if (prior) {
    run = ruleReplayRunSchema.parse(prior);
    if (
      run.workspaceId !== tx.workspaceId ||
      run.id !== id ||
      run.snapshotId !== stored.snapshot.snapshotId ||
      run.inputHash !== stored.inputHash
    )
      throw new Error(
        "Another candidate already occupies this evaluation slot",
      );
  } else {
    await tx.capture.reserve();
    run = ruleReplayRunSchema.parse({
      id,
      workspaceId: tx.workspaceId,
      snapshotId: stored.snapshot.snapshotId,
      inputHash: stored.inputHash,
      revision: 1,
      status: "queued",
      nextBatch: 0,
      cursor: null,
      decisionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await tx.capture.insert(stored, run);
    await enqueueRuleReplay(tx, run);
  }
  const next = await save(
    tx,
    row,
    {
      ...row,
      ...(heldOut ? { heldOutRunId: id } : { fullRunId: id }),
      revision: row.revision + 1,
      updatedAt: now,
    },
    "rule.proposal_evaluation_started",
  );
  await tx.proposals.scheduleEvaluation(next);
  return { state: "completed" };
}
async function reportState(
  tx: RuleProposalTransaction,
  id: string,
): Promise<"ready" | "waiting" | "failed"> {
  const raw = await tx.replay.lock(id);
  if (!raw) return "failed";
  const run = ruleReplayRunSchema.parse(raw);
  if (run.workspaceId !== tx.workspaceId || run.id !== id)
    throw new PersistenceError("scope_violation");
  if (run.status === "cancelled") return "failed";
  if (run.status === "completed" && (await tx.reports.get(id))) return "ready";
  const state = await tx.proposals.workState(
    run.status === "completed"
      ? ruleBacktestJobId(tx.workspaceId, id)
      : ruleReplayJobId(tx.workspaceId, id, run.nextBatch),
  );
  return state === "pending" || state === "running" ? "waiting" : "failed";
}
/** One replay reservation per transaction. Successor jobs commit with their
 * proposal revision; a retry of an older revision has no additional effects. */
export class RuleProposalEvaluation {
  constructor(private readonly repository: RuleProposalRepository) {}
  /** Called before host generation polling. Terminal/missing evaluation jobs
   * cannot permanently consume proposal capacity. One audited failure per poll. */
  recover(scope: WorkLease["workspaceId"]): Promise<boolean> {
    return this.repository.transaction(scope, async (tx) => {
      for (const id of await tx.proposals.evaluatingIds()) {
        const raw = await tx.proposals.lock(id);
        if (!raw) continue;
        const row = ruleProposalSchema.parse(raw);
        if (row.workspaceId !== tx.workspaceId || row.id !== id)
          throw new PersistenceError("scope_violation");
        if (row.status !== "evaluating") continue;
        const now = await tx.proposals.currentTime();
        const expired = compareUtcTimestamps(now, row.expiresAt) >= 0;
        const state = await tx.proposals.workState(
          ruleProposalEvaluationJobId(scope, row.id, row.revision),
        );
        if (!expired && (state === "pending" || state === "running")) continue;
        await fail(tx, row, now, expired);
        return true;
      }
      return false;
    });
  }
  process(lease: WorkLease): Promise<WorkResult> {
    const hint = ruleProposalEvaluationJobSchema.parse(lease.payload);
    if (
      lease.queue !== "job" ||
      lease.kind !== "rules.proposal-evaluate" ||
      lease.id !==
        ruleProposalEvaluationJobId(
          lease.workspaceId,
          hint.proposalId,
          hint.revision,
        )
    )
      throw new Error("Invalid proposal evaluation lease");
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const raw = await tx.proposals.lock(hint.proposalId),
        claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "completed" };
      const payload = ruleProposalEvaluationJobSchema.parse(claim.payload);
      if (
        claim.workspaceId !== tx.workspaceId ||
        claim.id !== lease.id ||
        claim.kind !== lease.kind ||
        payload.proposalId !== hint.proposalId ||
        payload.revision !== hint.revision
      )
        throw new Error("Proposal evaluation claim mismatch");
      if (!raw) return { state: "completed" };
      const row = ruleProposalSchema.parse(raw);
      if (row.workspaceId !== tx.workspaceId || row.id !== hint.proposalId)
        throw new PersistenceError("scope_violation");
      if (row.status !== "evaluating" || row.revision !== hint.revision)
        return { state: "completed" };
      let now = await tx.proposals.currentTime();
      if (compareUtcTimestamps(now, row.expiresAt) >= 0)
        return fail(tx, row, now, true);
      if (!row.fullRunId) return startReplay(tx, row, false, now);
      // Finish the full replay before reserving the held-out slot. Three
      // proposals must not deadlock the shared three-run replay capacity.
      const full = await reportState(tx, row.fullRunId);
      if (full === "failed") return fail(tx, row, now, false);
      if (full === "waiting") return { state: "wait", delayMs: 60000 };
      if (row.heldOut === "required" && !row.heldOutRunId)
        return startReplay(tx, row, true, now);
      const held = row.heldOutRunId
        ? await reportState(tx, row.heldOutRunId)
        : "ready";
      if (held === "failed") return fail(tx, row, now, false);
      if (held === "waiting") return { state: "wait", delayMs: 60000 };
      now = await tx.proposals.currentTime();
      if (compareUtcTimestamps(now, row.expiresAt) >= 0)
        return fail(tx, row, now, true);
      // The transaction wrapper verifies every report seal before allowing readiness;
      // host FKs then pin those reports atomically with this update.
      await save(
        tx,
        row,
        { ...row, status: "ready", revision: row.revision + 1, updatedAt: now },
        "rule.proposal_ready",
      );
      return { state: "completed" };
    });
  }
}
