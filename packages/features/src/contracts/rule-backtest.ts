import { ruleCandidateEvaluationSchema } from "./rule-proposal.js";
import { ruleEvaluationSealSchema } from "./rule-evaluation.js";
import { ruleComparisonSchema } from "./rule-comparison.js";
import { z } from "zod";
import { detectionRuleVersionSchema } from "./rule-state.js";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { compareUtcTimestamps } from "./timestamps.js";
const count = z.number().int().min(0).max(44641);
const fraction = z.number().finite().min(0).max(1);
export const backtestDecisionRangeSchema = z
  .strictObject({
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
    decisions: count.min(1),
  })
  .refine(
    (x) => compareUtcTimestamps(x.firstDecisionAt, x.lastDecisionAt) <= 0,
    "Invalid decision range",
  );
export const backtestEpisodeSchema = z
  .strictObject({
    startedAt: utcTimestampSchema,
    endedAt: utcTimestampSchema.nullable(),
    outcome: z.enum(["actionable", "noise", "unreviewed"]),
    labelId: opaqueIdSchema.nullable(),
  })
  .refine(
    (x) => (x.outcome === "unreviewed") === (x.labelId === null),
    "Reviewed episode requires label",
  )
  .refine(
    (x) =>
      x.endedAt === null || compareUtcTimestamps(x.startedAt, x.endedAt) < 0,
    "Invalid episode interval",
  );
export type BacktestEpisode = z.infer<typeof backtestEpisodeSchema>;
/** Strict, credential-free persisted report. Availability refers to decision
 * windows, not a claim of continuous source uptime between them. */
const ruleBacktestReportShape = z.strictObject({
  version: z.literal(1),
  evaluatorVersion: z.literal(1),
  evaluation: ruleEvaluationSealSchema.optional(),
  candidateEvaluation: ruleCandidateEvaluationSchema.optional(),
  matchingPolicy: z.literal("unique-overlap-v1"),
  comparison: ruleComparisonSchema.nullable().default(null),
  snapshotId: opaqueIdSchema,
  rule: detectionRuleVersionSchema,
  status: z.enum(["BACKTESTED", "NOT_BACKTESTABLE"]),
  reason: z.enum([
    "complete",
    "partial_history",
    "incomplete_input",
    "no_usable_history",
  ]),
  simulation: z.strictObject({
    initialState: z.literal("inactive"),
    warmupUntil: utcTimestampSchema,
  }),
  range: z.strictObject({
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
  }),
  coverage: z.strictObject({
    totalDecisions: count.min(1),
    evaluatedDecisions: count,
    suppressedDecisions: count,
    unknownDecisions: count,
    fraction,
  }),
  availability: z.strictObject({
    semantics: z.literal("decision_windows"),
    firstUsableDecisionAt: utcTimestampSchema.nullable(),
    lastUsableDecisionAt: utcTimestampSchema.nullable(),
    available: z.array(backtestDecisionRangeSchema).max(44641),
    gaps: z
      .array(
        z.strictObject({
          range: backtestDecisionRangeSchema,
          reason: z.string().min(1).max(64),
        }),
      )
      .max(44641),
  }),
  episodes: z.array(backtestEpisodeSchema).max(44641),
  reviewedLabels: count.max(1000),
  unreviewedEpisodes: count,
  ambiguousEpisodes: count,
  truePositives: count,
  falsePositives: count,
  missedLabelIds: z.array(opaqueIdSchema).max(1000),
  unevaluableLabelIds: z.array(opaqueIdSchema).max(1000),
  precision: z.strictObject({
    value: fraction.nullable(),
    denominator: count,
    wilson95: z.strictObject({ low: fraction, high: fraction }).nullable(),
  }),
  labelCoverage: fraction.nullable(),
});
type ReportShape = z.infer<typeof ruleBacktestReportShape>;
/** An evaluation reuses another capture of the same decision range, never this report's own snapshot. */
function evaluationRangeMismatch(
  evaluation: {
    sourceSnapshotId: string;
    firstDecisionAt: string;
    lastDecisionAt: string;
  },
  r: ReportShape,
): boolean {
  return (
    evaluation.sourceSnapshotId === r.snapshotId ||
    compareUtcTimestamps(
      evaluation.firstDecisionAt,
      r.range.firstDecisionAt,
    ) !== 0 ||
    compareUtcTimestamps(evaluation.lastDecisionAt, r.range.lastDecisionAt) !==
      0
  );
}
function comparisonScopeMismatch(r: ReportShape): boolean {
  const b = r.rule.definition;
  return Boolean(
    r.comparison?.groups.some((g) => {
      const a = g.observation.version.definition;
      return (
        a.workspaceId !== b.workspaceId ||
        a.serviceId !== b.serviceId ||
        a.environmentId !== b.environmentId ||
        a.selector.kind !== b.selector.kind ||
        a.selector.streamId !== b.selector.streamId
      );
    }),
  );
}
/** Coverage, precision and label coverage must all follow from the decision and episode counts. */
function countsConsistent(r: ReportShape): boolean {
  const cover = r.coverage,
    n = r.truePositives + r.falsePositives;
  return !(
    cover.totalDecisions !==
      cover.evaluatedDecisions +
        cover.suppressedDecisions +
        cover.unknownDecisions ||
    cover.fraction !== cover.evaluatedDecisions / cover.totalDecisions ||
    n !== r.precision.denominator ||
    r.episodes.length !== n + r.unreviewedEpisodes ||
    r.ambiguousEpisodes > r.unreviewedEpisodes ||
    r.precision.value !== (n ? r.truePositives / n : null) ||
    (r.precision.wilson95 === null) !== (n === 0) ||
    r.labelCoverage !== (r.episodes.length ? n / r.episodes.length : null)
  );
}
/** Available and gap ranges partition the decision range, and their totals match the coverage. */
function checkAvailability(
  r: ReportShape,
  issue: (message: string) => void,
): void {
  const ranges = [
    ...r.availability.available,
    ...r.availability.gaps.map((g) => g.range),
  ].sort((a, b) => compareUtcTimestamps(a.firstDecisionAt, b.firstDecisionAt));
  const step = r.rule.definition.stepSeconds * 1000;
  let next = Date.parse(r.range.firstDecisionAt),
    total = 0;
  for (const range of ranges) {
    if (
      Date.parse(range.firstDecisionAt) !== next ||
      Date.parse(range.lastDecisionAt) !== next + (range.decisions - 1) * step
    )
      issue("Availability must partition decision range");
    next = Date.parse(range.lastDecisionAt) + step;
    total += range.decisions;
  }
  if (
    total !== r.coverage.totalDecisions ||
    next !== Date.parse(r.range.lastDecisionAt) + step ||
    r.availability.available.reduce((s, x) => s + x.decisions, 0) !==
      r.coverage.evaluatedDecisions ||
    r.availability.firstUsableDecisionAt !==
      (r.availability.available[0]?.firstDecisionAt ?? null) ||
    r.availability.lastUsableDecisionAt !==
      (r.availability.available.at(-1)?.lastDecisionAt ?? null)
  )
    issue("Availability summary mismatch");
}
export const ruleBacktestReportSchema = ruleBacktestReportShape.superRefine(
  (r, c) => {
    if (
      r.candidateEvaluation &&
      (r.evaluation || evaluationRangeMismatch(r.candidateEvaluation, r))
    )
      c.addIssue({
        code: "custom",
        message: "Candidate evaluation binding mismatch",
      });

    if (
      r.comparison &&
      (r.comparison.candidatePredictedOpenings !== r.episodes.length ||
        r.comparison.candidateEvaluatedDecisions !==
          r.coverage.evaluatedDecisions)
    )
      c.addIssue({
        code: "custom",
        message: "Comparison candidate counts mismatch",
      });
    if (comparisonScopeMismatch(r))
      c.addIssue({ code: "custom", message: "Comparison scope mismatch" });
    if (r.evaluation && evaluationRangeMismatch(r.evaluation, r))
      c.addIssue({
        code: "custom",
        message: "Report evaluation range mismatch",
      });
    if (!countsConsistent(r))
      c.addIssue({ code: "custom", message: "Inconsistent backtest counts" });
    const cover = r.coverage;
    if (
      r.truePositives !==
        r.episodes.filter((e) => e.outcome === "actionable").length ||
      r.falsePositives !==
        r.episodes.filter((e) => e.outcome === "noise").length ||
      (r.status === "BACKTESTED") !==
        ["complete", "partial_history"].includes(r.reason) ||
      (r.status === "BACKTESTED" && cover.evaluatedDecisions === 0)
    )
      c.addIssue({ code: "custom", message: "Report outcome/status mismatch" });
    checkAvailability(r, (message) => c.addIssue({ code: "custom", message }));
  },
);
export type RuleBacktestReport = z.infer<typeof ruleBacktestReportSchema>;
