import {
  deploymentEntrySchema,
  deploymentWatchRecordSchema,
  evaluatedWatchStreamSchema,
  utcTimestampSchema,
  opaqueIdSchema,
  deploymentWatchSeconds,
  deploymentWatchReceiptGraceSeconds,
  type DeploymentEntry,
  type DeploymentWatchRecord,
  type EvaluatedWatchStream,
} from "../../contracts/index.js";
import { compareCodeUnits } from "../../contracts/ordering.js";
/** A finish records a separate server-time watch, including failure/cancellation and a late finish after timeout. */
export function startDeploymentWatch(
  raw: DeploymentEntry,
): DeploymentWatchRecord {
  const entry = deploymentEntrySchema.parse(raw),
    deployment = entry.deployment;
  if (!deployment.finish)
    throw new RangeError("A recorded finish is required for a watch");
  const startedAt = deployment.finish.receivedAt;
  return deploymentWatchRecordSchema.parse({
    formatVersion: 1,
    workspaceId: deployment.workspaceId,
    targetId: entry.targetId,
    deploymentId: deployment.id,
    serviceId: deployment.serviceId,
    environmentId: deployment.environmentId,
    revision: 1,
    startedAt,
    endsAt: new Date(
      Date.parse(startedAt) + deploymentWatchSeconds * 1000,
    ).toISOString(),
    updatedAt: startedAt,
    evaluatedAt: null,
    finalizedAt: null,
    verdict: "PENDING",
    inventoryComplete: false,
    streams: [],
    firstFailure: null,
    incidentId: null,
    overlappingDeploymentIds: [],
    overlapInventoryComplete: false,
  });
}
export interface WatchEvaluationUpdate {
  evaluatedAt: string;
  streams: EvaluatedWatchStream[];
  inventoryComplete: boolean;
  overlappingDeploymentIds: string[];
  overlapInventoryComplete: boolean;
}
/** Orchestration must produce these evaluations with evaluateWatchStream and the immutable baseline.
 * Persist and link a newly failed watch's incident atomically; later health never erases its first failure.
 */
export function advanceDeploymentWatch(
  raw: DeploymentWatchRecord,
  update: WatchEvaluationUpdate,
): DeploymentWatchRecord {
  const current = deploymentWatchRecordSchema.parse(raw);
  if (
    typeof update.inventoryComplete !== "boolean" ||
    typeof update.overlapInventoryComplete !== "boolean"
  )
    throw new RangeError("Invalid inventory completeness");
  const at = Date.parse(utcTimestampSchema.parse(update.evaluatedAt));
  if (at < Date.parse(current.updatedAt))
    throw new RangeError("Watch time moved backwards");
  if (current.finalizedAt !== null) return current;
  if (
    update.streams.length > 128 ||
    update.overlappingDeploymentIds.length > 128
  )
    throw new RangeError("Watch inventory exceeds bound");
  const final =
    at >=
    Date.parse(current.endsAt) + deploymentWatchReceiptGraceSeconds * 1000;
  const streams = update.streams.map((stream) =>
    evaluatedWatchStreamSchema.parse(stream),
  );
  for (const stream of streams)
    if (
      stream.evaluation.evaluatedAt !== update.evaluatedAt ||
      stream.evaluation.final !== final
    )
      throw new RangeError("Watch evaluation cutoff differs");
  streams.sort(
    (a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.id, b.id),
  );
  const firstFailure =
    current.firstFailure ??
    streams.find((stream) => stream.evaluation.verdict === "FAIL") ??
    null;
  const incomplete =
    !update.inventoryComplete ||
    streams.length === 0 ||
    streams.some((stream) => stream.evaluation.verdict === "INSUFFICIENT_DATA");
  let verdict: "FAIL" | "INSUFFICIENT_DATA" | "PENDING" | "WARN" | "PASS";
  if (firstFailure) verdict = "FAIL";
  else if (incomplete) verdict = "INSUFFICIENT_DATA";
  else if (!final) verdict = "PENDING";
  else if (streams.some((stream) => stream.evaluation.verdict === "WARN"))
    verdict = "WARN";
  else if (streams.every((stream) => stream.evaluation.verdict === "PASS"))
    verdict = "PASS";
  else verdict = "INSUFFICIENT_DATA";
  const overlaps = [
    ...new Set([
      ...current.overlappingDeploymentIds,
      ...update.overlappingDeploymentIds.map((id) => opaqueIdSchema.parse(id)),
    ]),
  ].sort();
  if (overlaps.includes(current.deploymentId))
    throw new RangeError("A deployment cannot overlap itself");
  return deploymentWatchRecordSchema.parse({
    ...current,
    revision: current.revision + 1,
    updatedAt: update.evaluatedAt,
    evaluatedAt: update.evaluatedAt,
    finalizedAt: final ? update.evaluatedAt : null,
    verdict,
    inventoryComplete: update.inventoryComplete,
    streams,
    firstFailure,
    overlappingDeploymentIds: overlaps.slice(0, 128),
    overlapInventoryComplete:
      (current.evaluatedAt === null || current.overlapInventoryComplete) &&
      update.overlapInventoryComplete &&
      overlaps.length <= 128,
  });
}
/** Called only after finding/creating the related scoped incident in the same transaction. */
export function linkWatchIncident(
  raw: DeploymentWatchRecord,
  incidentId: string,
): DeploymentWatchRecord {
  const value = deploymentWatchRecordSchema.parse(raw),
    id = opaqueIdSchema.parse(incidentId);
  if (
    !value.firstFailure ||
    (value.incidentId !== null && value.incidentId !== id)
  )
    throw new RangeError("Watch incident link is immutable");
  return deploymentWatchRecordSchema.parse({ ...value, incidentId: id });
}
