import { z } from "zod";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  deploymentEntrySchema,
  deploymentBaselineSeconds,
  replayCoverageSnapshotSchema,
  watchEvidenceWindowSchema,
  sustainedFloorRuleSchema,
  type DeploymentEntry,
  type DeploymentBaseline,
  type WatchEvidenceWindow,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { replayCoverageSegments } from "../retention/reader.js";
import { probeWatchCriteria, metricWatchCriteria } from "./watch.js";
import { validateDeploymentBaseline } from "./baseline.js";
/** Hosts hash this closed measurement projection as PostgreSQL canonical jsonb text.
 * Cadence-only probe revisions remain comparable; metric step changes do not.
 * The hash is a compatibility marker, never an authentication mechanism.
 */
export const watchMeasurementFields = Object.freeze({
  probe: Object.freeze([
    "config",
    "critical",
    "failureThreshold",
    "recoveryThreshold",
  ]),
  metric: Object.freeze(["query", "rule", "stepSeconds"]),
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const common = {
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  id: opaqueIdSchema,
  sourceId: opaqueIdSchema,
  configurationVersion: revision,
  measurementHash: hash,
  complete: z.boolean(),
  configurations: z
    .array(
      replayCoverageSnapshotSchema.shape.configurations.element.extend({
        measurementHash: hash,
      }),
    )
    .max(128),
  receipts: z
    .array(
      watchEvidenceWindowSchema.shape.samples.element.extend({
        version: revision.nullable(),
        slotAt: utcTimestampSchema.nullable(),
      }),
    )
    .max(128),
};
export const baselineProjectionSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  capturedAt: utcTimestampSchema,
  inventoryComplete: z.boolean(),
  streams: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          ...common,
          kind: z.literal("probe"),
          critical: z.boolean(),
          failureThreshold: z.number().int().min(1).max(10),
        }),
        z.strictObject({
          ...common,
          kind: z.literal("metric"),
          rule: sustainedFloorRuleSchema,
        }),
      ]),
    )
    .max(128),
});
export type BaselineProjection = z.infer<typeof baselineProjectionSchema>;
/** Pure conversion of a coherent host snapshot. Actual observations are retained,
 * while query definitions, URLs, request bodies and credential references are not.
 */
export function baselineFromProjection(
  rawEntry: DeploymentEntry,
  raw: unknown,
): DeploymentBaseline {
  const entry = deploymentEntrySchema.parse(rawEntry);
  const projection = baselineProjectionSchema.parse(raw);
  const deployment = entry.deployment;
  if (
    projection.workspaceId !== deployment.workspaceId ||
    projection.serviceId !== deployment.serviceId ||
    projection.environmentId !== deployment.environmentId
  )
    throw new PersistenceError("scope_violation");
  const window = {
    startAt: new Date(
      Date.parse(deployment.startedAt) - deploymentBaselineSeconds * 1000,
    ).toISOString(),
    endAt: deployment.startedAt,
    visibleAt: projection.capturedAt,
  };
  return validateDeploymentBaseline(
    {
      formatVersion: 1,
      workspaceId: deployment.workspaceId,
      targetId: entry.targetId,
      deploymentId: deployment.id,
      serviceId: deployment.serviceId,
      environmentId: deployment.environmentId,
      startedAt: deployment.startedAt,
      capturedAt: projection.capturedAt,
      inventoryComplete: projection.inventoryComplete,
      streams: projection.streams.map((stream) => {
        if (
          stream.workspaceId !== projection.workspaceId ||
          stream.serviceId !== projection.serviceId ||
          stream.environmentId !== projection.environmentId
        )
          throw new PersistenceError("scope_violation");
        return {
          kind: stream.kind,
          id: stream.id,
          sourceId: stream.sourceId,
          configurationVersion: stream.configurationVersion,
          measurementHash: stream.measurementHash,
          criteria:
            stream.kind === "probe"
              ? probeWatchCriteria(stream)
              : metricWatchCriteria(stream),
          evidence: projectedEvidenceWindow(
            stream,
            projection.workspaceId,
            window,
            stream.measurementHash,
          ),
        };
      }),
    },
    entry,
  );
}

/** Shared baseline/watch projection. Watch readers may include future slots up to their fixed end;
 * trim those to the evaluation window before using the same coverage and receipt selection rules.
 */
export function projectedEvidenceWindow(
  stream: BaselineProjection["streams"][number],
  scope: BaselineProjection["workspaceId"],
  window: Pick<WatchEvidenceWindow, "startAt" | "endAt" | "visibleAt">,
  measurementHash: string,
  trimFutureSlots = false,
): WatchEvidenceWindow {
  if (stream.workspaceId !== scope)
    throw new PersistenceError("scope_violation");
  const segments = replayCoverageSegments(stream.configurations, window);
  const versions = new Set(segments.map((segment) => segment.version));
  const compatible = stream.configurations.every(
    (config) =>
      !versions.has(config.version) ||
      config.measurementHash === measurementHash,
  );
  const samples = stream.receipts.flatMap((receipt) => {
    if (receipt.reading.kind !== stream.kind)
      throw new RangeError("Observation kind differs");
    if (receipt.version === null || receipt.slotAt === null) return [];
    const slot = Date.parse(receipt.slotAt);
    if (trimFutureSlots && slot >= Date.parse(window.endAt)) return [];
    if (slot < Date.parse(window.startAt) || slot >= Date.parse(window.endAt))
      throw new RangeError("Receipt outside window");
    return [{ ...receipt, version: receipt.version, slotAt: receipt.slotAt }];
  });
  return {
    workspaceId: scope,
    streamId: stream.id,
    ...window,
    complete: stream.complete,
    configurationCompatible: compatible,
    segments,
    samples,
  };
}
