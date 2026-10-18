import {
  deploymentWatchRecordSchema,
  deploymentBaselineStreamSchema,
  probeSchema,
  utcTimestampSchema,
  watchCadenceLeaseSchema,
  deploymentWatchProbeIntervalSeconds,
  type DeploymentWatchRecord,
  type DeploymentBaselineStream,
  type Probe,
  type WatchCadenceLease,
  type WatchCadenceReceipt,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
export type WatchCadencePlan =
  | {
      state: "skip";
      decision: Exclude<
        WatchCadenceReceipt["decision"],
        "tightened" | "joined" | "capacity_limited"
      >;
    }
  | { state: "join"; lease: WatchCadenceLease }
  | { state: "tighten"; probe: Probe; lease: WatchCadenceLease };
function binding(probe: Probe, lease: WatchCadenceLease) {
  for (const key of [
    "workspaceId",
    "sourceId",
    "serviceId",
    "environmentId",
  ] as const)
    if (probe[key] !== lease[key])
      throw new PersistenceError("scope_violation");
  if (probe.id !== lease.probeId) throw new PersistenceError("scope_violation");
}
/** Pure plan only. Caller first validates the immutable watch inventory, serializes
 * capacity and probe ownership, checks any existing application receipt, then
 * capacity-checks a tightening candidate before atomically persisting all effects.
 */
export function planWatchCadence(
  rawWatch: DeploymentWatchRecord,
  rawCaptured: DeploymentBaselineStream,
  rawProbe: Probe,
  rawLease: WatchCadenceLease | undefined,
  rawNow: string,
): WatchCadencePlan {
  const watch = deploymentWatchRecordSchema.parse(rawWatch),
    captured = deploymentBaselineStreamSchema.parse(rawCaptured),
    probe = probeSchema.parse(rawProbe),
    lease = rawLease ? watchCadenceLeaseSchema.parse(rawLease) : undefined,
    now = utcTimestampSchema.parse(rawNow);
  if (
    captured.kind !== "probe" ||
    captured.id !== probe.id ||
    captured.sourceId !== probe.sourceId ||
    captured.evidence.workspaceId !== watch.workspaceId ||
    captured.evidence.streamId !== probe.id ||
    watch.workspaceId !== probe.workspaceId ||
    watch.serviceId !== probe.serviceId ||
    watch.environmentId !== probe.environmentId
  )
    throw new PersistenceError("scope_violation");
  if (lease) {
    binding(probe, lease);
    if (lease.targetId !== watch.targetId)
      throw new PersistenceError("scope_violation");
  }
  if (
    Date.parse(now) < Date.parse(watch.startedAt) ||
    Date.parse(now) < Date.parse(probe.updatedAt) ||
    (lease && Date.parse(now) < Date.parse(lease.createdAt))
  )
    throw new RangeError("Cadence time moved backwards");
  if (Date.parse(now) >= Date.parse(watch.endsAt))
    return { state: "skip", decision: "expired" };
  if (!probe.enabled) return { state: "skip", decision: "disabled" };
  if (lease) {
    if (
      probe.version !== lease.appliedProbeVersion ||
      probe.intervalSeconds !== deploymentWatchProbeIntervalSeconds
    )
      return { state: "skip", decision: "superseded" };
    return {
      state: "join",
      lease: watchCadenceLeaseSchema.parse({
        ...lease,
        revision: lease.revision + 1,
        restoreAt: new Date(
          Math.max(Date.parse(lease.restoreAt), Date.parse(watch.endsAt)),
        ).toISOString(),
      }),
    };
  }
  if (probe.intervalSeconds <= deploymentWatchProbeIntervalSeconds)
    return { state: "skip", decision: "already_fast" };
  // A delayed first application must not override configuration edited after
  // baseline capture. An existing owned lease above is the only safe exception.
  if (probe.version !== captured.configurationVersion)
    return { state: "skip", decision: "superseded" };
  const next = probeSchema.parse({
    ...probe,
    version: probe.version + 1,
    intervalSeconds: deploymentWatchProbeIntervalSeconds,
    updatedAt: now,
  });
  return {
    state: "tighten",
    probe: next,
    lease: watchCadenceLeaseSchema.parse({
      workspaceId: probe.workspaceId,
      targetId: watch.targetId,
      probeId: probe.id,
      sourceId: probe.sourceId,
      serviceId: probe.serviceId,
      environmentId: probe.environmentId,
      generationDeploymentId: watch.deploymentId,
      generationId: pagingWorkId(
        probe.workspaceId,
        "watch-cadence-lease",
        watch.deploymentId,
        probe.id,
      ),
      revision: 1,
      originalIntervalSeconds: probe.intervalSeconds,
      appliedProbeVersion: next.version,
      createdAt: now,
      restoreAt: watch.endsAt,
    }),
  };
}
export type WatchCadenceRestorePlan =
  | { state: "wait"; dueAt: string }
  | { state: "superseded" }
  | { state: "restore"; probe: Probe };
/** Caller fences the persisted generation/job and holds capacity+probe locks. */
export function planWatchCadenceRestore(
  rawLease: WatchCadenceLease,
  rawProbe: Probe,
  rawNow: string,
): WatchCadenceRestorePlan {
  const lease = watchCadenceLeaseSchema.parse(rawLease),
    probe = probeSchema.parse(rawProbe),
    now = utcTimestampSchema.parse(rawNow);
  binding(probe, lease);
  if (
    Date.parse(now) < Date.parse(lease.createdAt) ||
    Date.parse(now) < Date.parse(probe.updatedAt)
  )
    throw new RangeError("Cadence time moved backwards");
  if (
    probe.version !== lease.appliedProbeVersion ||
    probe.intervalSeconds !== deploymentWatchProbeIntervalSeconds ||
    !probe.enabled
  )
    return { state: "superseded" };
  if (Date.parse(now) < Date.parse(lease.restoreAt))
    return { state: "wait", dueAt: lease.restoreAt };
  return {
    state: "restore",
    probe: probeSchema.parse({
      ...probe,
      version: probe.version + 1,
      intervalSeconds: lease.originalIntervalSeconds,
      updatedAt: now,
    }),
  };
}
