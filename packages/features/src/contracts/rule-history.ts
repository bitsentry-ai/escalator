import { z } from "zod";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { replayCoverageSnapshotSchema } from "./replay-reader.js";
import { ruleSampleSchema } from "./rules.js";
const measurementHash = z.string().regex(/^[a-f0-9]{64}$/);
/** Bounded scalar projection. Provider payloads and secret references never enter replay. */
export const ruleHistorySnapshotSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  kind: z.enum(["probe", "metric", "signal"]),
  streamId: opaqueIdSchema,
  snapshotAt: utcTimestampSchema,
  startAt: utcTimestampSchema,
  endAt: utcTimestampSchema,
  visibleAt: utcTimestampSchema,
  complete: z.boolean(),
  configurations: z
    .array(
      replayCoverageSnapshotSchema.shape.configurations.element.extend({
        measurementHash,
      }),
    )
    .max(10000),
  receipts: z
    .array(
      z.strictObject({
        version: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable(),
        sample: ruleSampleSchema,
      }),
    )
    .max(100000),
});
export type RuleHistorySnapshot = z.infer<typeof ruleHistorySnapshotSchema>;
export const ruleMeasurementHashSchema = measurementHash;

/** One decision's right-closed sample range, with an independent receipt cutoff. */
export const ruleHistoryQuerySchema = z
  .strictObject({
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    kind: z.enum(["probe", "metric", "signal"]),
    streamId: opaqueIdSchema,
    startAt: utcTimestampSchema,
    endAt: utcTimestampSchema,
    visibleAt: utcTimestampSchema,
  })
  .refine(
    (row) =>
      Date.parse(row.endAt) > Date.parse(row.startAt) &&
      Date.parse(row.endAt) - Date.parse(row.startAt) <= 86400000 &&
      Date.parse(row.endAt) <= Date.parse(row.visibleAt),
    "Invalid rule history window",
  );
export type RuleHistoryQuery = z.infer<typeof ruleHistoryQuerySchema>;
