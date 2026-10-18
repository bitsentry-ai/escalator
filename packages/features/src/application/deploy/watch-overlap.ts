import { z } from "zod";
import {
  deploymentWatchRecordSchema,
  deploymentWatchSeconds,
  deploymentWatchReceiptGraceSeconds,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type DeploymentWatchRecord,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import type { WatchEvaluationUpdate } from "./watch-record.js";
/** Scope and receipt visibility accompany the bounded SQL projection. */
export const watchOverlapProjectionSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  asOf: utcTimestampSchema,
  rows: z
    .array(
      z.strictObject({
        id: opaqueIdSchema,
        startedAt: utcTimestampSchema,
        acceptedAt: utcTimestampSchema,
        finishedAt: utcTimestampSchema.nullable(),
        /** Without a visible finish, the trusted timeout bounds the execution window. */
        timedOutAt: utcTimestampSchema.nullable(),
      }),
    )
    .max(129),
});
/** Match the evidence receipt cutoff even when the worker resumes much later. */
export function deploymentWatchOverlapVisibleAt(
  rawWatch: DeploymentWatchRecord,
  rawAt: string,
): string {
  const watch = deploymentWatchRecordSchema.parse(rawWatch),
    at = Date.parse(utcTimestampSchema.parse(rawAt));
  if (at < Date.parse(watch.startedAt))
    throw new RangeError("Overlap projection predates watch");
  return new Date(
    Math.min(
      at,
      Date.parse(watch.endsAt) + deploymentWatchReceiptGraceSeconds * 1000,
    ),
  ).toISOString();
}
/** Correlation covers execution AND its following watch window. An earlier
 * finish does not prove exclusive attribution while its own watch still overlaps.
 * Truncation is explicit; callers never claim deployment causality from this list.
 */
export function deploymentWatchOverlaps(
  rawWatch: DeploymentWatchRecord,
  rawProjection: unknown,
): Pick<
  WatchEvaluationUpdate,
  "overlappingDeploymentIds" | "overlapInventoryComplete"
> {
  const watch = deploymentWatchRecordSchema.parse(rawWatch),
    projection = watchOverlapProjectionSchema.parse(rawProjection);
  if (
    projection.workspaceId !== watch.workspaceId ||
    projection.serviceId !== watch.serviceId ||
    projection.environmentId !== watch.environmentId
  )
    throw new PersistenceError("scope_violation");
  const asOf = Date.parse(projection.asOf),
    start = Date.parse(watch.startedAt),
    end = Date.parse(watch.endsAt);
  if (
    asOf !== Date.parse(deploymentWatchOverlapVisibleAt(watch, projection.asOf))
  )
    throw new RangeError("Overlap projection exceeds receipt cutoff");
  const seen = new Set<string>();
  for (const row of projection.rows) {
    const began = Date.parse(row.startedAt),
      accepted = Date.parse(row.acceptedAt),
      finished = row.finishedAt === null ? null : Date.parse(row.finishedAt),
      timedOut = row.timedOutAt === null ? null : Date.parse(row.timedOutAt),
      ended = finished ?? timedOut;
    if (row.id === watch.deploymentId || seen.has(row.id))
      throw new RangeError("Invalid overlap identity");
    seen.add(row.id);
    if (
      began > accepted ||
      accepted > asOf ||
      began >= end ||
      (finished !== null && (finished < accepted || finished > asOf)) ||
      (timedOut !== null && (timedOut < accepted || timedOut > asOf)) ||
      (ended !== null && ended + deploymentWatchSeconds * 1000 <= start)
    )
      throw new RangeError("Invalid overlap chronology");
  }
  return {
    overlappingDeploymentIds: projection.rows
      .slice(0, 128)
      .map((row) => row.id),
    overlapInventoryComplete: projection.rows.length <= 128,
  };
}
