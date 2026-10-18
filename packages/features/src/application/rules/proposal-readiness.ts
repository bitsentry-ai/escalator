import { createHash } from "node:crypto";
import {
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import {
  ruleReplayRunSchema,
  storedRuleReplaySnapshotSchema,
} from "../../contracts/replay-run.js";
import { ruleBacktestRecordSchema } from "../../contracts/backtest-record.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleBacktestTransaction } from "./backtest-ports.js";
import { deriveCandidateReplay } from "./candidate-replay.js";
import { deriveHeldOutReplay } from "./held-out.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Readiness is report attachment, not activation. Unknown history may be shown
 * for shadow review; activation has its own explicit eligibility checks. */
export async function assertProposalReports(
  tx: RuleBacktestTransaction,
  raw: RuleProposal,
): Promise<void> {
  const row = ruleProposalSchema.parse(raw);
  if (row.workspaceId !== tx.workspaceId)
    throw new PersistenceError("scope_violation");
  if (row.status !== "ready" || !row.generation || !row.fullRunId)
    throw new Error("Proposal is not ready for report attachment");
  const loaded = await tx.replay.snapshot(row.sourceSnapshotId);
  if (!loaded) throw new Error("Proposal capture unavailable");
  const source = storedRuleReplaySnapshotSchema.parse(loaded);
  if (
    source.workspaceId !== tx.workspaceId ||
    source.snapshot.snapshotId !== row.sourceSnapshotId ||
    source.inputHash !== row.sourceInputHash
  )
    throw new PersistenceError("scope_violation");
  const candidate = row.generation.candidate;
  const expected = [
    { id: row.fullRunId, source: deriveCandidateReplay(source, candidate) },
  ];
  if (row.heldOut === "required") {
    if (!row.heldOutRunId) throw new Error("Held-out report required");
    expected.push({
      id: row.heldOutRunId,
      source: deriveHeldOutReplay(source, candidate),
    });
  }
  for (const item of expected) {
    const runRaw = await tx.replay.lock(item.id),
      reportRaw = await tx.reports.get(item.id);
    if (!runRaw || !reportRaw)
      throw new Error("Proposal evaluation report unavailable");
    const run = ruleReplayRunSchema.parse(runRaw),
      report = ruleBacktestRecordSchema.parse(reportRaw),
      snapshot = item.source.snapshot;
    if (
      run.workspaceId !== tx.workspaceId ||
      report.workspaceId !== tx.workspaceId ||
      run.id !== item.id ||
      report.runId !== item.id ||
      run.snapshotId !== snapshot.snapshotId ||
      report.snapshotId !== snapshot.snapshotId ||
      run.inputHash !== item.source.inputHash ||
      report.inputHash !== item.source.inputHash
    )
      throw new PersistenceError("scope_violation");
    const count =
      Math.floor(
        (Date.parse(snapshot.lastDecisionAt) -
          Date.parse(snapshot.firstDecisionAt)) /
          (snapshot.version.definition.stepSeconds * 1000),
      ) + 1;
    if (
      run.status !== "completed" ||
      run.decisionCount !== count ||
      report.report.coverage.totalDecisions !== count ||
      hash(report.report.rule) !== hash(candidate) ||
      JSON.stringify(report.report.evaluation) !==
        JSON.stringify(snapshot.evaluation) ||
      JSON.stringify(report.report.candidateEvaluation) !==
        JSON.stringify(snapshot.candidateEvaluation) ||
      report.report.range.firstDecisionAt !== snapshot.firstDecisionAt ||
      report.report.range.lastDecisionAt !== snapshot.lastDecisionAt ||
      compareUtcTimestamps(report.createdAt, run.updatedAt) < 0
    )
      throw new Error("Proposal report does not match its sealed evaluation");
  }
}
