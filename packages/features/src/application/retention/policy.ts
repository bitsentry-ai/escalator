import { z } from "zod";
import {
  replayRetentionSettingsSchema,
  utcTimestampSchema,
  type ReplayRetentionSettings,
} from "../../contracts/index.js";
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const replayUsageSchema = z
  .strictObject({
    retainedBytes: bytes,
    protectedBytes: bytes,
  })
  .refine(
    (value) => value.protectedBytes <= value.retainedBytes,
    "Protected bytes cannot exceed retained bytes",
  );
export type ReplayUsage = z.infer<typeof replayUsageSchema>;
/** Hosts pass database time. No caller-controlled clock or wall-clock subtraction. */
export function retentionTarget(
  settings: ReplayRetentionSettings,
  databaseNow: string,
  usage: ReplayUsage,
) {
  const policy = replayRetentionSettingsSchema.parse(settings);
  const now = Date.parse(utcTimestampSchema.parse(databaseNow));
  const snapshot = replayUsageSchema.parse(usage);
  const cutoffAt = utcTimestampSchema.parse(
    new Date(now - policy.days * 86400000).toISOString(),
  );
  return {
    cutoffAt,
    overBudgetBytes: Math.max(0, snapshot.retainedBytes - policy.maxBytes),
    protectedOverageBytes: Math.max(
      0,
      snapshot.protectedBytes - policy.maxBytes,
    ),
    eligibleBytes: snapshot.retainedBytes - snapshot.protectedBytes,
  };
}
