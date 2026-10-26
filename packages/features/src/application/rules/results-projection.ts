import { z } from "zod";
import { detectionRuleVersionSchema } from "../../contracts/rule-state.js";
import { opaqueIdSchema, type WorkspaceId } from "../../contracts/identity.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import {
  ruleReplayResultSchema,
  ruleProposalViewSchema,
  ruleBacktestSummarySchema,
} from "../../contracts/rule-results.js";
import { decodeRuleReplayRun } from "./replay-storage-codec.js";
import { decodeRuleProposal } from "./proposal-storage.js";
import { ruleReplayJobId } from "./replay-job.js";
import { ruleBacktestJobId } from "./backtest-job.js";
import { PersistenceError } from "../ports/persistence.js";
/** A stored report wins; otherwise the run and its replay job together say how far the replay got. */
function replayState(reported: boolean, runStatus: string, job: unknown) {
  if (reported) return "completed";
  if (runStatus === "cancelled") return "cancelled";
  if (job === "failed") return "failed";
  if (job === "cancelled") return "cancelled";
  if (job !== "pending" && job !== "running") return "unknown";
  if (runStatus === "completed") return "reporting";
  if (job === "running" || runStatus === "running") return "replaying";
  return "queued";
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const object = z.record(z.string(), z.unknown());
const snapshotSchema = z.strictObject({
  snapshotId: opaqueIdSchema,
  inputHash: hash,
  originalRetained: z.boolean(),
  version: detectionRuleVersionSchema,
  firstDecisionAt: utcTimestampSchema,
  lastDecisionAt: utcTimestampSchema,
});
const reportSchema = z.strictObject({
  runId: opaqueIdSchema,
  snapshotId: opaqueIdSchema,
  inputHash: hash,
  rule: detectionRuleVersionSchema,
  summary: ruleBacktestSummarySchema,
});
export const ruleResultsJobStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type RuleResultsJobState = z.infer<typeof ruleResultsJobStateSchema>;
function scopedVersion(scope: WorkspaceId, raw: unknown) {
  const v = object.parse(raw),
    definition = object.parse(v.definition);
  return detectionRuleVersionSchema.parse({
    ...v,
    definition: { ...definition, workspaceId: scope },
  });
}
export function ruleResultJobId(scope: WorkspaceId, raw: unknown) {
  const run = decodeRuleReplayRun(scope, raw);
  return run.status === "completed"
    ? ruleBacktestJobId(scope, run.id)
    : ruleReplayJobId(scope, run.id, run.nextBatch);
}
/** Input is a SQL projection, never a complete snapshot or full report. */
export function projectRuleReplayResult(
  scope: WorkspaceId,
  rawRun: unknown,
  rawSnapshot: unknown,
  rawReport: unknown,
  job: RuleResultsJobState | undefined,
) {
  const run = decodeRuleReplayRun(scope, rawRun),
    s = object.parse(rawSnapshot);
  const snapshot = snapshotSchema.parse({
    ...s,
    version: scopedVersion(scope, s.version),
  });
  if (
    snapshot.snapshotId !== run.snapshotId ||
    snapshot.inputHash !== run.inputHash
  )
    throw new PersistenceError("scope_violation");
  let report = null;
  if (rawReport !== null) {
    const r = object.parse(rawReport),
      bound = reportSchema.parse({ ...r, rule: scopedVersion(scope, r.rule) });
    if (
      run.status !== "completed" ||
      bound.runId !== run.id ||
      bound.snapshotId !== run.snapshotId ||
      bound.inputHash !== run.inputHash ||
      JSON.stringify(bound.rule) !== JSON.stringify(snapshot.version) ||
      bound.summary.range.firstDecisionAt !== snapshot.firstDecisionAt ||
      bound.summary.range.lastDecisionAt !== snapshot.lastDecisionAt
    )
      throw new PersistenceError("scope_violation");
    report = bound.summary;
  }
  const state = replayState(report !== null, run.status, job);
  return ruleReplayResultSchema.parse({
    id: run.id,
    workspaceId: scope,
    snapshotId: run.snapshotId,
    version: snapshot.version,
    firstDecisionAt: snapshot.firstDecisionAt,
    lastDecisionAt: snapshot.lastDecisionAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    decisionCount: run.decisionCount,
    proposalSource: snapshot.originalRetained,
    state,
    report,
  });
}
export function projectRuleProposal(
  scope: WorkspaceId,
  raw: unknown,
  serviceId: string,
  environmentId: string,
) {
  const p = decodeRuleProposal(scope, raw);
  return ruleProposalViewSchema.parse({
    id: p.id,
    workspaceId: scope,
    serviceId,
    environmentId,
    candidateId: p.candidateId,
    originLabelId: p.originLabelId,
    sourceSnapshotId: p.sourceSnapshotId,
    status: p.status,
    failure: p.failure,
    heldOut: p.heldOut,
    fullRunId: p.fullRunId,
    heldOutRunId: p.heldOutRunId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
    candidate: p.generation?.candidate ?? null,
    rationale: p.generation?.rationale ?? null,
  });
}
