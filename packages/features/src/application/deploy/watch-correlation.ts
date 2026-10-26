import {
  deploymentWatchRecordSchema,
  opaqueIdSchema,
  type DeploymentWatchRecord,
} from "../../contracts/index.js";
import {
  alertGroupKey,
  alertIdentity,
} from "../../domain/alerts/transition.js";
import type { DetectionTransaction } from "../detection/ports.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
export interface WatchIncidentBinding {
  incidentId: string | null;
  /** After the watch's page exists and its work claim is fenced, in this same transaction. */
  attach(incidentId: string): Promise<void>;
}
export interface WatchIncidentCorrelation {
  /** Read/lock only. Captured source locks must already be held before this group lock. */
  lock(watch: DeploymentWatchRecord): Promise<WatchIncidentBinding>;
}
type Group = NonNullable<
  Awaited<ReturnType<DetectionTransaction["detection"]["lockGroup"]>>
>;
type Incident = Awaited<ReturnType<DetectionTransaction["incidents"]["get"]>>;
/** The failed watch's first failing stream and its source, which must match the watch scope. */
async function failedWatchSource(
  tx: DetectionTransaction,
  watch: DeploymentWatchRecord,
) {
  if (watch.verdict !== "FAIL" || !watch.firstFailure)
    throw new Error("Only failed watches can correlate incidents");
  const failed = watch.firstFailure;
  const source = await tx.sources.get(failed.sourceId);
  if (
    !source ||
    source.workspaceId !== tx.workspaceId ||
    source.serviceId !== watch.serviceId ||
    source.environmentId !== watch.environmentId ||
    source.kind !== (failed.kind === "probe" ? "probe" : "metrics")
  )
    throw new PersistenceError("scope_violation");
  return { failed, source };
}
function assertWatchGroup(
  tx: DetectionTransaction,
  watch: DeploymentWatchRecord,
  group: Group,
): void {
  if (
    group.workspaceId !== tx.workspaceId ||
    group.serviceId !== watch.serviceId ||
    group.environmentId !== watch.environmentId
  )
    throw new PersistenceError("scope_violation");
}
/** Locks the group's incident page; the incident id while it is still open, else null. */
async function activeGroupIncident(
  tx: DetectionTransaction,
  watch: DeploymentWatchRecord,
  incidentId: string,
): Promise<string | null> {
  await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", incidentId));
  const incident = await tx.incidents.get(incidentId);
  if (
    !incident ||
    incident.serviceId !== watch.serviceId ||
    incident.environmentId !== watch.environmentId
  )
    throw new PersistenceError("scope_violation");
  return incident.resolvedAt ? null : incident.id;
}
/**
 * A concurrent manual resolution may release an alert's frozen grouping. Retry rather than attach a new incident to
 * a now-obsolete group identity.
 */
async function assertGroupingStable(
  tx: DetectionTransaction,
  priorId: string,
  sameKey: boolean,
): Promise<void> {
  await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", priorId));
  const fresh = await tx.incidents.get(priorId);
  if (fresh?.resolvedAt && !sameKey)
    throw new Error("Watch grouping changed during manual resolution; retry");
}
function assertWatchIncident(
  tx: DetectionTransaction,
  watch: DeploymentWatchRecord,
  incident: Incident,
): void {
  if (
    !incident ||
    incident.workspaceId !== tx.workspaceId ||
    incident.serviceId !== watch.serviceId ||
    incident.environmentId !== watch.environmentId
  )
    throw new PersistenceError("scope_violation");
}
/** Points the watch's group at a newly opened incident, cancelling the group's pending recovery. */
async function attachWatchGroup(
  tx: DetectionTransaction,
  watch: DeploymentWatchRecord,
  key: string,
  group: Group | undefined,
  incidentId: string,
): Promise<void> {
  if (group?.recoveryJobId) await tx.work.cancel("job", [group.recoveryJobId]);
  if (
    !(await tx.detection.putGroup(
      {
        id: key,
        workspaceId: tx.workspaceId,
        serviceId: watch.serviceId,
        environmentId: watch.environmentId,
        revision: (group?.revision ?? 0) + 1,
        incidentId,
        recoveryJobId: null,
      },
      group?.revision ?? null,
    ))
  )
    throw new Error("Locked watch group changed");
}
/** Reuse detection's actual fingerprint/group identities without manufacturing a
 * signal or overwriting its observation watermark. Pending ordinary detection
 * subsequently finds the watch's group incident instead of opening another page.
 */
export function watchIncidentCorrelation(
  tx: DetectionTransaction,
  guard: TransactionGuard,
): WatchIncidentCorrelation {
  return {
    lock: (raw) =>
      guard.operation(async () => {
        const watch = deploymentWatchRecordSchema.parse(raw);
        if (watch.workspaceId !== tx.workspaceId)
          throw new PersistenceError("scope_violation");
        const { failed, source } = await failedWatchSource(tx, watch);
        const identity = {
          workspaceId: tx.workspaceId,
          serviceId: watch.serviceId,
          environmentId: watch.environmentId,
          sourceId: source.id,
          fingerprint: `${failed.kind === "probe" ? "probe" : "metrics"}:${failed.id}`,
        };
        const alert = await tx.detection.alert(alertIdentity(identity));
        const prior = alert?.incidentId
          ? await tx.incidents.get(alert.incidentId)
          : undefined;
        if (alert?.incidentId && !prior)
          throw new Error("Alert incident is missing");
        const key =
          alert && prior && !prior.resolvedAt
            ? alert.groupKey
            : alertGroupKey(identity, source);
        const group = await tx.detection.lockGroup(key);
        if (group) assertWatchGroup(tx, watch, group);
        if (prior && !prior.resolvedAt && group?.incidentId !== prior.id)
          throw new Error("Active alert group differs from its incident");
        const incidentId = group?.incidentId
          ? await activeGroupIncident(tx, watch, group.incidentId)
          : null;
        if (prior && !prior.resolvedAt)
          await assertGroupingStable(
            tx,
            prior.id,
            key === alertGroupKey(identity, source),
          );
        let attached = false;
        return {
          incidentId,
          attach: (id) =>
            guard.operation(async () => {
              opaqueIdSchema.parse(id);
              if (attached)
                throw new Error("Watch correlation already attached");
              if (incidentId !== null && id !== incidentId)
                throw new PersistenceError("scope_violation");
              assertWatchIncident(tx, watch, await tx.incidents.get(id));
              if (incidentId === null)
                await attachWatchGroup(tx, watch, key, group, id);
              // Preserve an existing incident's acknowledgement/recovery state and jobs.
              attached = true;
            }),
        };
      }),
  };
}
