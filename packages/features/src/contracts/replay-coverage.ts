import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const timestamp = utcTimestampSchema;
const period = { startAt: timestamp, endAt: timestamp };
const segmentSchema = z.strictObject({
  ...period,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  recordedAt: timestamp.nullable(),
  enabled: z.boolean(),
  anchorAt: timestamp,
  stepSeconds: z.number().int().min(1).max(86400),
});
const sampleSchema = z.strictObject({
  id: opaqueIdSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  slotAt: timestamp,
  observedAt: timestamp,
  receivedAt: timestamp.nullable(),
  usable: z.boolean(),
});
export const periodicCoverageInputSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  streamId: opaqueIdSchema,
  ...period,
  visibleAt: timestamp,
  /** Query must include the complete configuration manifest and receipts for this range. */
  complete: z.boolean(),
  segments: z.array(segmentSchema).max(10000),
  samples: z.array(sampleSchema).max(100000),
});
export type PeriodicCoverageInput = z.infer<typeof periodicCoverageInputSchema>;
export type CoverageReason =
  | "configuration_unknown"
  | "configuration_unavailable"
  | "disabled"
  | "missing"
  | "late"
  | "retrospective"
  | "unusable"
  | "query_truncated";
export interface CoverageGap {
  startAt: string;
  endAt: string;
  reason: CoverageReason;
}
export const eventCoverageInputSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  streamId: opaqueIdSchema,
  ...period,
  visibleAt: timestamp,
  complete: z.boolean(),
  events: z
    .array(
      z.strictObject({
        id: opaqueIdSchema,
        observedAt: timestamp,
        receivedAt: timestamp.nullable(),
      }),
    )
    .max(100000),
});
export type EventCoverageInput = z.infer<typeof eventCoverageInputSchema>;
export type CoverageSample = z.infer<typeof sampleSchema>;
export interface PeriodicCoverageReport {
  coverageVersion: 1;
  expectedSlots: number;
  availableSlots: number;
  gaps: CoverageGap[];
  queryComplete: boolean;
}
export interface EventCoverageReport {
  coverageVersion: 1;
  visibleCount: number;
  lateCount: number;
  retrospectiveCount: number;
  queryComplete: boolean;
  continuity: "not_inferred";
}
