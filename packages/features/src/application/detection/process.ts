import { z } from "zod";
import {
  opaqueIdSchema,
  policyDefinition,
  type AlertGroup,
  type AlertState,
  type ProcessedSignal,
  type SignalEvent,
} from "../../contracts/index.js";
import {
  alertGroupKey,
  alertIdentity,
  transitionAlert,
} from "../../domain/alerts/transition.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import { openPageInTransaction } from "../paging/create-page.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { DetectionRepository, DetectionTransaction } from "./ports.js";
import { recoveryDeadline, scheduleRecovery } from "./recovery.js";
const payloadSchema = z.strictObject({ signalId: opaqueIdSchema });
const actor = { kind: "system", component: "detection" } as const;
/** A newer active observation after this alert recovered is a relapse, even if it predates resolution. */
const relapses = (alert: AlertState | undefined, signal: SignalEvent) =>
  !!alert &&
  !alert.active &&
  signal.status === "active" &&
  Date.parse(signal.observedAt) > Date.parse(alert.observedAt);
async function receipt(
  tx: DetectionTransaction,
  signal: SignalEvent,
  disposition: ProcessedSignal["disposition"],
  incidentId: string | null,
) {
  await tx.detection.recordProcessed({
    id: signal.id,
    workspaceId: tx.workspaceId,
    sourceId: signal.sourceId,
    disposition,
    incidentId,
    recordedAt: tx.now,
  });
  await tx.audit.append({
    id: `signal.processed:${signal.id}`,
    workspaceId: tx.workspaceId,
    actor,
    action: "signal.processed",
    subjectType: "signal",
    subjectId: signal.id,
    recordedAt: tx.now,
    metadata: { disposition, incidentId },
  });
}
/** Only persisted events and claimed work may open pages. Receipt and page share the transaction. */
export class SignalProcessing {
  constructor(private readonly repository: DetectionRepository) {}
  process(lease: WorkLease): Promise<WorkResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const signal = await tx.signals.get(hint.signalId);
      if (!signal) throw new Error("Signal job references a missing event");
      const source = await tx.sources.get(signal.sourceId);
      if (!source) throw new Error("Signal job references a missing source");
      let current = await tx.detection.alert(alertIdentity(signal));
      let previousIncident = current?.incidentId
        ? await tx.incidents.get(current.incidentId)
        : undefined;
      const key =
        current?.incidentId && !previousIncident?.resolvedAt
          ? current.groupKey
          : alertGroupKey(signal, source);
      let group = await tx.detection.lockGroup(key);
      // Manual resolution also takes this page lock. Re-read its incident after acquiring it.
      if (current?.incidentId) {
        await tx.pages.lock(
          pagingWorkId(tx.workspaceId, "page", current.incidentId),
        );
        previousIncident = await tx.incidents.get(current.incidentId);
        if (!previousIncident) throw new Error("Alert incident is missing");
      }
      if (group?.incidentId && group.incidentId !== current?.incidentId)
        await tx.pages.lock(
          pagingWorkId(tx.workspaceId, "page", group.incidentId),
        );
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      if (
        claimed.queue !== "job" ||
        claimed.kind !== "signal.process" ||
        claimed.id !== `signal.process:${signal.id}` ||
        payloadSchema.parse(claimed.payload).signalId !== signal.id
      )
        throw new Error("Invalid signal processing claim");
      if (await tx.detection.processed(signal.id))
        return { state: "completed" };
      if (previousIncident?.resolvedAt) {
        if (
          Date.parse(signal.observedAt) <=
            Date.parse(previousIncident.resolvedAt) &&
          !relapses(current, signal)
        ) {
          await receipt(tx, signal, "manually_resolved", previousIncident.id);
          return { state: "completed" };
        }
        current = current ? { ...current, incidentId: null } : undefined;
      }
      const service = await tx.services.get(signal.serviceId);
      const decision = transitionAlert(
        current,
        signal,
        { ...source, enabled: source.enabled && !!service?.enabled },
        await tx.currentTime(),
      );
      if (decision.state === "ignored") {
        await receipt(tx, signal, decision.reason, current?.incidentId ?? null);
        return { state: "completed" };
      }
      if (decision.alert.groupKey !== key)
        throw new Error(
          "Grouping changed during manual resolution; retry with fresh locks",
        );
      let incident = group?.incidentId
        ? await tx.incidents.get(group.incidentId)
        : undefined;
      if (group?.incidentId && !incident)
        throw new Error("Group incident is missing");
      if (incident?.resolvedAt) {
        if (
          Date.parse(signal.observedAt) <= Date.parse(incident.resolvedAt) &&
          !relapses(current, signal)
        ) {
          await receipt(tx, signal, "manually_resolved", incident.id);
          return { state: "completed" };
        }
        incident = undefined;
      }
      if (!incident && decision.alert.active) {
        const binding = await tx.detection.binding(
          signal.serviceId,
          signal.environmentId,
        );
        const policy =
          binding?.enabled && binding.policyId
            ? await tx.configuration.policies.get(binding.policyId)
            : undefined;
        if (!policy?.enabled || policy.serviceId !== signal.serviceId)
          throw new Error("Automatic paging policy is unavailable");
        const id = pagingWorkId(
          tx.workspaceId,
          "signal-incident",
          key,
          signal.id,
        );
        await openPageInTransaction(
          tx,
          {
            incident: {
              id,
              serviceId: signal.serviceId,
              environmentId: signal.environmentId,
              title: signal.title,
              severity: signal.severity,
            },
            policy: policyDefinition(policy),
          },
          actor,
        );
        incident = await tx.incidents.get(id);
        if (!incident)
          throw new Error("Page creation did not persist its incident");
      }
      const next: AlertGroup = {
        id: key,
        workspaceId: tx.workspaceId,
        serviceId: signal.serviceId,
        environmentId: signal.environmentId,
        revision: (group?.revision ?? 0) + 1,
        incidentId: incident?.id ?? null,
        recoveryJobId: null,
      };
      if (group?.recoveryJobId)
        await tx.work.cancel("job", [group.recoveryJobId]);
      if (!(await tx.detection.putGroup(next, group?.revision ?? null)))
        throw new Error("Locked group revision changed");
      group = next;
      await tx.detection.putAlert({
        ...decision.alert,
        incidentId: incident?.id ?? null,
      });
      if (incident)
        group = await scheduleRecovery(
          tx,
          group,
          await recoveryDeadline(tx, incident.id),
        );
      await receipt(
        tx,
        signal,
        decision.alert.active ? "active" : "recovered",
        incident?.id ?? null,
      );
      return { state: "completed" };
    });
  }
}
