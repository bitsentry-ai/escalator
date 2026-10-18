import {
  compareUtcTimestamps,
  hasSubmillisecondTime,
} from "./timestamps.js";
import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { ruleSampleSchema } from "./rules.js";
import {
  detectionRuleVersionSchema,
  ruleEvaluationStateSchema,
  type RuleTransition,
} from "./rule-state.js";

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
