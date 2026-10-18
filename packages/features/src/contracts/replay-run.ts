import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { compareUtcTimestamps } from "./timestamps.js";
import {
  ruleReplayCursorSchema,
  ruleReplaySnapshotSchema,
} from "./rule-replay.js";
import { ruleEvaluationStateSchema } from "./rule-state.js";

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const persistedRuleTransitionSchema = z.strictObject({
  state: ruleEvaluationStateSchema,
  status: z.enum(["evaluated", "suppressed", "duplicate", "stale"]),
  action: z.enum(["opened", "recovered", "none"]),
  episodeStartedAt: utcTimestampSchema.nullable(),
  verdict: z
    .strictObject({
      evaluatorVersion: z.literal(1),
      state: z.enum(["trigger", "recovery", "hold", "insufficient_data"]),
      reason: z.enum([
        "trigger",
        "recovery",
        "between_thresholds",
        "invalid_input",
        "unaligned_window",
        "incomplete_read",
        "coverage_unknown",
        "coverage_gaps",
        "scope_mismatch",
        "conflicting_samples",
        "retrospective_samples",
        "late_samples",
        "missing_samples",
        "unusable_samples",
        "insufficient_requests",
      ]),
      value: z.number().finite().nullable(),
      sampleCount: counter,
      lateCount: counter,
      retrospectiveCount: counter,
    })
    .nullable(),
});
/** Snapshots are immutable, bounded and scalar-only. A host must capture them
 * from retained evidence; accepting client-supplied coverage would bypass review. */
export const storedRuleReplaySnapshotSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    snapshot: ruleReplaySnapshotSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (row) => row.workspaceId === row.snapshot.version.definition.workspaceId,
    "Snapshot tenant mismatch",
  )
  .refine((row) => {
    const rule = row.snapshot.version.definition;
    return row.snapshot.samples.every(
      (sample) =>
        sample.workspaceId === rule.workspaceId &&
        sample.serviceId === rule.serviceId &&
        sample.environmentId === rule.environmentId &&
        sample.kind === rule.selector.kind &&
        sample.streamId === rule.selector.streamId,
    );
  }, "Snapshot sample scope mismatch");
export type StoredRuleReplaySnapshot = z.infer<
  typeof storedRuleReplaySnapshotSchema
>;
export const ruleReplayRunSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    snapshotId: opaqueIdSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["queued", "running", "completed", "cancelled"]),
    nextBatch: z.number().int().min(0).max(44641),
    cursor: ruleReplayCursorSchema.nullable(),
    decisionCount: z.number().int().min(0).max(44641),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .superRefine((row, ctx) => {
    if (
      row.cursor !== null &&
      (row.cursor.snapshotId !== row.snapshotId ||
        row.cursor.state.workspaceId !== row.workspaceId)
    )
      ctx.addIssue({ code: "custom", message: "Replay cursor scope mismatch" });
    if (
      (row.decisionCount === 0) !== (row.cursor === null) ||
      (row.nextBatch === 0) !== (row.decisionCount === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Replay progress is inconsistent",
      });
    if (compareUtcTimestamps(row.updatedAt, row.createdAt) < 0)
      ctx.addIssue({
        code: "custom",
        message: "Replay update precedes creation",
      });
    if (row.status === "running" && row.cursor === null)
      ctx.addIssue({
        code: "custom",
        message: "Running replay requires progress",
      });
    if (row.status === "queued" && row.nextBatch !== 0)
      ctx.addIssue({
        code: "custom",
        message: "Queued replay already has results",
      });
  });
export type RuleReplayRun = z.infer<typeof ruleReplayRunSchema>;
export const ruleReplayChunkSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    runId: opaqueIdSchema,
    batch: z.number().int().min(0).max(44640),
    snapshotId: opaqueIdSchema,
    decisions: z.array(persistedRuleTransitionSchema).min(1).max(60),
  })
  .superRefine((row, ctx) => {
    if (row.decisions.some((d) => d.state.workspaceId !== row.workspaceId))
      ctx.addIssue({ code: "custom", message: "Replay chunk tenant mismatch" });
  });
export type RuleReplayChunk = z.infer<typeof ruleReplayChunkSchema>;
export const ruleReplayJobSchema = z.strictObject({
  runId: opaqueIdSchema,
  batch: z.number().int().min(0).max(44640),
});
