import {
  deploymentEntrySchema,
  deploymentWatchRecordSchema,
  deploymentWatchReceiptGraceSeconds,
  type DeploymentEntry,
  type DeploymentBaseline,
  type DeploymentWatchRecord,
  type WatchEvidenceWindow,
  type WorkspaceId,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import {
  baselineProjectionSchema,
  projectedEvidenceWindow,
} from "./baseline-reader.js";
import { validateDeploymentBaseline } from "./baseline.js";
import { evaluateWatchStream } from "./watch.js";
import type { WatchEvaluationUpdate } from "./watch-record.js";
/** Current disabled state does not erase historical evidence. Hosts read only the captured source IDs. */
export function evaluateWatchProjection(
  rawEntry: DeploymentEntry,
  rawWatch: DeploymentWatchRecord,
  rawBaseline: DeploymentBaseline | undefined,
  rawProjection: unknown,
): Pick<
  WatchEvaluationUpdate,
  "evaluatedAt" | "streams" | "inventoryComplete"
> {
  const projection = baselineProjectionSchema.parse(rawProjection);
  const { entry, watch, baseline } = watchEvidenceContext(
    projection.workspaceId,
    rawEntry,
    rawWatch,
    rawBaseline,
  );
  const owner = entry.deployment;
  if (
    projection.serviceId !== owner.serviceId ||
    projection.environmentId !== owner.environmentId
  )
    throw new PersistenceError("scope_violation");
  if (Date.parse(projection.capturedAt) <= Date.parse(watch.startedAt))
    throw new RangeError("Invalid watch projection chronology");
  for (const stream of projection.streams)
    if (
      stream.workspaceId !== owner.workspaceId ||
      stream.serviceId !== owner.serviceId ||
      stream.environmentId !== owner.environmentId
    )
      throw new PersistenceError("scope_violation");
  const at = Date.parse(projection.capturedAt),
    end = Date.parse(watch.endsAt);
  const window = {
    startAt: watch.startedAt,
    endAt: new Date(Math.min(at, end)).toISOString(),
    visibleAt: new Date(
      Math.min(at, end + deploymentWatchReceiptGraceSeconds * 1000),
    ).toISOString(),
  };
  if (!baseline)
    return {
      evaluatedAt: projection.capturedAt,
      streams: [],
      inventoryComplete: false,
    };
  const seen = new Set<string>();
  for (const stream of projection.streams) {
    const key = stream.kind + ":" + stream.id;
    if (seen.has(key)) throw new RangeError("Duplicate projected stream");
    seen.add(key);
  }
  let complete = baseline.inventoryComplete && projection.inventoryComplete;
  const streams = baseline.streams.map((captured) => {
    const current = projection.streams.find(
      (stream) => stream.kind === captured.kind && stream.id === captured.id,
    );
    if (current && current.sourceId !== captured.sourceId)
      throw new PersistenceError("scope_violation");
    if (!current) complete = false;
    const evidence: WatchEvidenceWindow = current
      ? projectedEvidenceWindow(
          current,
          owner.workspaceId,
          window,
          captured.measurementHash,
          true,
        )
      : {
          workspaceId: owner.workspaceId,
          streamId: captured.id,
          ...window,
          complete: false,
          configurationCompatible: false,
          segments: [],
          samples: [],
        };
    return {
      kind: captured.kind,
      id: captured.id,
      sourceId: captured.sourceId,
      evaluation: evaluateWatchStream(owner.workspaceId, {
        deploymentStartedAt: owner.startedAt,
        watchEndsAt: watch.endsAt,
        evaluatedAt: projection.capturedAt,
        criteria: captured.criteria,
        baseline: captured.evidence,
        watch: evidence,
      }),
    };
  });
  return {
    evaluatedAt: projection.capturedAt,
    streams,
    inventoryComplete: complete,
  };
}

/** Shared binding validation before host SQL acquires any locks or reads evidence. */
export function watchEvidenceContext(
  scope: WorkspaceId,
  rawEntry: DeploymentEntry,
  rawWatch: DeploymentWatchRecord,
  rawBaseline: DeploymentBaseline | undefined,
) {
  const entry = deploymentEntrySchema.parse(rawEntry),
    watch = deploymentWatchRecordSchema.parse(rawWatch),
    owner = entry.deployment;
  if (
    owner.workspaceId !== scope ||
    watch.workspaceId !== scope ||
    watch.targetId !== entry.targetId ||
    watch.deploymentId !== owner.id ||
    watch.serviceId !== owner.serviceId ||
    watch.environmentId !== owner.environmentId
  )
    throw new PersistenceError("scope_violation");
  if (
    !owner.finish ||
    Date.parse(owner.finish.receivedAt) !== Date.parse(watch.startedAt)
  )
    throw new RangeError("Watch does not match accepted finish");
  const baseline = rawBaseline
    ? validateDeploymentBaseline(rawBaseline, entry)
    : undefined;
  if (baseline && Date.parse(baseline.capturedAt) > Date.parse(watch.startedAt))
    throw new RangeError("Baseline is newer than the watch");
  return {
    entry,
    watch,
    baseline,
    sourceIds: baseline?.streams.map((stream) => stream.sourceId) ?? [],
  };
}
