import { z } from "zod";
import { workspaceIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
/** Replay payload budget, not a promise about total PostgreSQL disk usage.
 * Protected operational references may prevent reaching the maintenance target.
 * Raw provider bodies are not retained by the current ingress adapters.
 */
export const replayRetentionSettingsSchema = z.strictObject({
  days: z.number().int().min(1).max(365),
  maxBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(1024 ** 4),
});
export type ReplayRetentionSettings = z.infer<
  typeof replayRetentionSettingsSchema
>;
export const defaultReplayRetention: Readonly<ReplayRetentionSettings> =
  Object.freeze({
    days: 30,
    maxBytes: 5 * 1024 ** 3,
  });
export const replayRetentionPolicySchema = replayRetentionSettingsSchema.extend(
  {
    workspaceId: workspaceIdSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updatedAt: utcTimestampSchema,
  },
);
export type ReplayRetentionPolicy = z.infer<typeof replayRetentionPolicySchema>;
export const updateReplayRetentionSchema = replayRetentionSettingsSchema.extend(
  {
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  },
);
export type UpdateReplayRetention = z.input<typeof updateReplayRetentionSchema>;
