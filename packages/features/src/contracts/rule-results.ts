import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { detectionRuleVersionSchema } from "./rule-state.js";
import { ruleBacktestReportSchema } from "./rule-backtest.js";
import { ruleProposalSchema } from "./rule-proposal.js";
const count = z.number().int().min(0).max(44641);
const report = ruleBacktestReportSchema.shape;
/** Bounded display data, never an activation proof. Full sealed reports stay server-side. */
export const ruleBacktestSummarySchema = z
  .strictObject({
    status: report.status,
    reason: report.reason,
    simulation: report.simulation,
    range: report.range,
    coverage: report.coverage,
    episodeCount: count,
    reviewedLabels: report.reviewedLabels,
    unreviewedEpisodes: report.unreviewedEpisodes,
    ambiguousEpisodes: report.ambiguousEpisodes,
    truePositives: report.truePositives,
    falsePositives: report.falsePositives,
    missedLabels: count.max(1000),
    unevaluableLabels: count.max(1000),
    precision: report.precision,
    labelCoverage: report.labelCoverage,
  })
  .superRefine((r, c) => {
    if (
      r.episodeCount !==
        r.truePositives + r.falsePositives + r.unreviewedEpisodes ||
      r.precision.denominator !== r.truePositives + r.falsePositives ||
      r.precision.value !==
        (r.precision.denominator
          ? r.truePositives / r.precision.denominator
          : null) ||
      (r.precision.denominator === 0) !== (r.precision.wilson95 === null) ||
      r.ambiguousEpisodes > r.unreviewedEpisodes ||
      r.labelCoverage !==
        (r.episodeCount ? r.precision.denominator / r.episodeCount : null) ||
      r.coverage.fraction !==
        r.coverage.evaluatedDecisions / r.coverage.totalDecisions ||
      (r.status === "BACKTESTED") !==
        ["complete", "partial_history"].includes(r.reason) ||
      (r.status === "BACKTESTED" && r.coverage.evaluatedDecisions === 0) ||
      r.coverage.totalDecisions !==
        r.coverage.evaluatedDecisions +
          r.coverage.suppressedDecisions +
          r.coverage.unknownDecisions
    )
      c.addIssue({ code: "custom", message: "Invalid report counts" });
  });
export const ruleResultsListSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  ruleId: opaqueIdSchema.optional(),
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(25).default(10),
});
export const ruleProposalsListSchema = ruleResultsListSchema.extend({
  originLabelId: opaqueIdSchema.optional(),
});
export type RuleProposalsList = z.infer<typeof ruleProposalsListSchema>;
export const ruleResultIdSchema = z.strictObject({ id: opaqueIdSchema });
export const ruleReplayResultSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    snapshotId: opaqueIdSchema,
    version: detectionRuleVersionSchema,
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    decisionCount: count,
    proposalSource: z.boolean(),
    state: z.enum([
      "queued",
      "replaying",
      "reporting",
      "completed",
      "failed",
      "cancelled",
      "unknown",
    ]),
    report: ruleBacktestSummarySchema.nullable(),
  })
  .refine(
    (r) =>
      r.workspaceId === r.version.definition.workspaceId &&
      (r.state === "completed") === (r.report !== null),
    "Replay result binding mismatch",
  );
const proposal = ruleProposalSchema.shape;
export const ruleProposalViewSchema = z
  .strictObject({
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    candidateId: proposal.candidateId,
    originLabelId: proposal.originLabelId,
    sourceSnapshotId: proposal.sourceSnapshotId,
    status: proposal.status,
    failure: proposal.failure,
    heldOut: proposal.heldOut,
    fullRunId: proposal.fullRunId,
    heldOutRunId: proposal.heldOutRunId,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    expiresAt: proposal.expiresAt,
    candidate: detectionRuleVersionSchema.nullable(),
    rationale: z.string().max(1600).nullable(),
  })
  .refine(
    (r) =>
      !r.candidate ||
      (r.candidate.id === r.candidateId &&
        r.candidate.definition.workspaceId === r.workspaceId &&
        r.candidate.definition.serviceId === r.serviceId &&
        r.candidate.definition.environmentId === r.environmentId),
    "Proposal view scope mismatch",
  );
export type RuleResultsList = z.infer<typeof ruleResultsListSchema>;
export type RuleReplayResult = z.infer<typeof ruleReplayResultSchema>;
export type RuleProposalView = z.infer<typeof ruleProposalViewSchema>;
