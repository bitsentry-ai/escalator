import { ruleBaselineCaptureSchema } from "./rule-comparison.js";
import {
  ruleHistorySnapshotSchema,
  ruleMeasurementHashSchema,
} from "./rule-history.js";
import { rulePolicyFactSchema } from "./rule-policy.js";
import { compareUtcTimestamps, hasSubmillisecondTime } from "./timestamps.js";
import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { ruleSampleSchema } from "./rules.js";
import {
  detectionRuleVersionSchema,
  ruleEvaluationStateSchema,
  type RuleTransition,
} from "./rule-state.js";

export const ruleRetainedEvidenceSchema = z.strictObject({
  baselines: ruleBaselineCaptureSchema.optional(),
  history: ruleHistorySnapshotSchema,
  measurementHash: ruleMeasurementHashSchema,
  policyFacts: z.array(rulePolicyFactSchema).max(10000),
  policyComplete: z.boolean(),
});
export type RuleRetainedEvidence = z.infer<typeof ruleRetainedEvidenceSchema>;
const interval = {
  startAt: utcTimestampSchema,
  endAt: utcTimestampSchema,
  recordedAt: utcTimestampSchema.nullable(),
};
/** Coverage segments describe entire decision windows, not isolated receipts.
 * The retained-data adapter must prove every lookback in the segment has the
 * stated coverage, including configuration changes and retention gaps.
 */
export const ruleReplaySnapshotSchema = z
  .strictObject({
    retained: ruleRetainedEvidenceSchema.optional(),
    snapshotId: opaqueIdSchema,
    snapshotAt: utcTimestampSchema,
    version: detectionRuleVersionSchema,
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
    complete: z.boolean(),
    samples: z.array(ruleSampleSchema).max(100000),
    coverage: z
      .array(
        z.strictObject({
          ...interval,
          state: z.enum(["complete", "gaps", "unknown"]),
        }),
      )
      .max(10000),
    policies: z
      .array(
        z.strictObject({
          ...interval,
          enabled: z.boolean(),
          maintenance: z.boolean(),
        }),
      )
      .max(10000),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.retained) {
      const { history, policyFacts, policyComplete } = snapshot.retained;
      const rule = snapshot.version.definition;
      const delay = (rule.collectionDelaySeconds ?? 0) * 1000;
      const wrong =
        history.workspaceId !== rule.workspaceId ||
        history.serviceId !== rule.serviceId ||
        history.environmentId !== rule.environmentId ||
        history.kind !== rule.selector.kind ||
        history.streamId !== rule.selector.streamId;
      const wrongReceipt = history.receipts.some(
        ({ sample }) =>
          sample.workspaceId !== rule.workspaceId ||
          sample.serviceId !== rule.serviceId ||
          sample.environmentId !== rule.environmentId ||
          sample.kind !== rule.selector.kind ||
          sample.streamId !== rule.selector.streamId ||
          compareUtcTimestamps(sample.observedAt, snapshot.snapshotAt) > 0 ||
          (sample.receivedAt !== null &&
            compareUtcTimestamps(sample.receivedAt, snapshot.snapshotAt) > 0),
      );
      const baselines = snapshot.retained.baselines;
      const wrongBaseline =
        baselines &&
        (compareUtcTimestamps(baselines.visibleAt, snapshot.snapshotAt) !== 0 ||
          compareUtcTimestamps(
            baselines.firstDecisionAt,
            snapshot.firstDecisionAt,
          ) !== 0 ||
          compareUtcTimestamps(
            baselines.lastDecisionAt,
            snapshot.lastDecisionAt,
          ) !== 0 ||
          baselines.groups.some((g) => {
            const d = g.version.definition;
            return (
              d.workspaceId !== rule.workspaceId ||
              d.serviceId !== rule.serviceId ||
              d.environmentId !== rule.environmentId ||
              d.selector.kind !== rule.selector.kind ||
              d.selector.streamId !== rule.selector.streamId
            );
          }));
      const wrongFact = policyFacts.some(
        (f) =>
          f.workspaceId !== rule.workspaceId ||
          f.serviceId !== rule.serviceId ||
          (f.environmentId !== null &&
            f.environmentId !== rule.environmentId) ||
          compareUtcTimestamps(f.recordedAt, snapshot.snapshotAt) > 0,
      );
      if (
        wrong ||
        wrongReceipt ||
        wrongFact ||
        wrongBaseline ||
        snapshot.samples.length ||
        snapshot.coverage.length ||
        snapshot.policies.length ||
        snapshot.complete !== (history.complete && policyComplete) ||
        history.visibleAt !== snapshot.snapshotAt ||
        compareUtcTimestamps(
          history.startAt,
          new Date(
            Date.parse(snapshot.firstDecisionAt) -
              delay -
              rule.windowSeconds * 1000,
          ).toISOString(),
        ) !== 0 ||
        compareUtcTimestamps(
          history.endAt,
          new Date(Date.parse(snapshot.lastDecisionAt) - delay).toISOString(),
        ) !== 0 ||
        compareUtcTimestamps(history.snapshotAt, snapshot.snapshotAt) < 0
      )
        context.addIssue({
          code: "custom",
          message: "Retained replay scope, range or availability mismatch",
        });
    }
    const start = Date.parse(snapshot.firstDecisionAt),
      end = Date.parse(snapshot.lastDecisionAt);
    if (
      end < start ||
      end - start > 31 * 86400000 ||
      compareUtcTimestamps(snapshot.lastDecisionAt, snapshot.snapshotAt) > 0
    )
      context.addIssue({
        code: "custom",
        message: "Replay requires a past range of at most 31 days",
      });
    const step = snapshot.version.definition.stepSeconds * 1000;
    if (
      hasSubmillisecondTime(snapshot.firstDecisionAt) ||
      hasSubmillisecondTime(snapshot.lastDecisionAt) ||
      start % step !== 0 ||
      end % step !== 0
    )
      context.addIssue({
        code: "custom",
        message: "Replay decisions must be step aligned",
      });
    if (
      snapshot.samples.some(
        (row) =>
          row.receivedAt !== null &&
          compareUtcTimestamps(row.receivedAt, snapshot.snapshotAt) > 0,
      ) ||
      [...snapshot.policies, ...snapshot.coverage].some(
        (row) =>
          row.recordedAt !== null &&
          compareUtcTimestamps(row.recordedAt, snapshot.snapshotAt) > 0,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Snapshot cannot contain future receipts or records",
      });
  });
export type RuleReplaySnapshot = z.infer<typeof ruleReplaySnapshotSchema>;
export const ruleReplayCursorSchema = z.strictObject({
  snapshotId: opaqueIdSchema,
  state: ruleEvaluationStateSchema,
});
export type RuleReplayCursor = z.infer<typeof ruleReplayCursorSchema>;
export const ruleReplayBudgetSchema = z.strictObject({
  maxDecisions: z.number().int().min(1).max(1440),
  maxSampleVisits: z.number().int().min(1).max(1000000),
});
export type RuleReplayBudget = z.infer<typeof ruleReplayBudgetSchema>;
export interface RuleReplayBatch {
  evaluatorVersion: 1;
  snapshotId: string;
  status: "complete" | "budget_exhausted" | "cancelled";
  decisions: RuleTransition[];
  cursor: RuleReplayCursor | null;
  nextDecisionAt: string | null;
  sampleVisits: number;
}
