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
        if (
          group &&
          (group.workspaceId !== tx.workspaceId ||
            group.serviceId !== watch.serviceId ||
            group.environmentId !== watch.environmentId)
        )
          throw new PersistenceError("scope_violation");
        if (prior && !prior.resolvedAt && group?.incidentId !== prior.id)
          throw new Error("Active alert group differs from its incident");
        let incidentId: string | null = null;
        if (group?.incidentId) {
          await tx.pages.lock(
            pagingWorkId(tx.workspaceId, "page", group.incidentId),
          );
          const incident = await tx.incidents.get(group.incidentId);
          if (
            !incident ||
            incident.serviceId !== watch.serviceId ||
            incident.environmentId !== watch.environmentId
          )
            throw new PersistenceError("scope_violation");
          if (!incident.resolvedAt) incidentId = incident.id;
        }
        // A concurrent manual resolution may release an alert's frozen grouping.
        // Retry rather than attach a new incident to a now-obsolete group identity.
        if (prior && !prior.resolvedAt) {
          await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", prior.id));
          const fresh = await tx.incidents.get(prior.id);
          if (fresh?.resolvedAt && key !== alertGroupKey(identity, source))
            throw new Error(
              "Watch grouping changed during manual resolution; retry",
            );
        }
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
              const incident = await tx.incidents.get(id);
              if (
                !incident ||
                incident.workspaceId !== tx.workspaceId ||
                incident.serviceId !== watch.serviceId ||
                incident.environmentId !== watch.environmentId
              )
                throw new PersistenceError("scope_violation");
              if (incidentId === null) {
                if (group?.recoveryJobId)
                  await tx.work.cancel("job", [group.recoveryJobId]);
                if (
                  !(await tx.detection.putGroup(
                    {
                      id: key,
                      workspaceId: tx.workspaceId,
                      serviceId: watch.serviceId,
                      environmentId: watch.environmentId,
                      revision: (group?.revision ?? 0) + 1,
                      incidentId: id,
                      recoveryJobId: null,
                    },
                    group?.revision ?? null,
                  ))
                )
                  throw new Error("Locked watch group changed");
              }
              // Preserve an existing incident's acknowledgement/recovery state and jobs.
              attached = true;
            }),
        };
      }),
  };
}
