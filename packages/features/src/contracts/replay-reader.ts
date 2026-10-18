import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import type {
  EventCoverageReport,
  PeriodicCoverageReport,
} from "./replay-coverage.js";
export const replayCoverageQuerySchema = z
  .strictObject({
    kind: z.enum(["signal", "probe", "metric"]),
    id: opaqueIdSchema,
    startAt: utcTimestampSchema,
    endAt: utcTimestampSchema,
    visibleAt: utcTimestampSchema,
  })
  .refine((value) => {
    const from = Date.parse(value.startAt),
      to = Date.parse(value.endAt);
    return (
      to > from &&
      to - from <= 31 * 86400000 &&
      to <= Date.parse(value.visibleAt)
    );
  }, "Coverage requires a past window of at most 31 days");
export type ReplayCoverageQuery = z.infer<typeof replayCoverageQuerySchema>;
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const configuration = z.strictObject({
  version: revision,
  effectiveAt: utcTimestampSchema.nullable(),
  recordedAt: utcTimestampSchema.nullable(),
  enabled: z.boolean(),
  anchorAt: utcTimestampSchema,
  stepSeconds: z.number().int().min(60).max(3600),
});
const receipt = z.strictObject({
  id: opaqueIdSchema,
  version: revision.nullable(),
  slotAt: utcTimestampSchema.nullable(),
  observedAt: utcTimestampSchema,
  receivedAt: utcTimestampSchema.nullable(),
  usable: z.boolean(),
});
/** Metadata projection only: no provider payloads, credentials or large metric input lists. */
export const replayCoverageSnapshotSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  kind: replayCoverageQuerySchema.shape.kind,
  streamId: opaqueIdSchema,
  snapshotAt: utcTimestampSchema,
  complete: z.boolean(),
  configurations: z.array(configuration).max(10000),
  receipts: z.array(receipt).max(100000),
});
export type ReplayCoverageSnapshot = z.infer<
  typeof replayCoverageSnapshotSchema
>;
export interface ReplayCoverageResult {
  query: ReplayCoverageQuery;
  snapshotAt: string;
  /** Receipts lacking a known schedule/revision cannot be assigned to historical slots. */
  unassignedReceipts: number;
  report: EventCoverageReport | PeriodicCoverageReport;
}
