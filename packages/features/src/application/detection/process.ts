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
export const signalProcessingPayloadSchema = z.strictObject({
  signalId: opaqueIdSchema,
});
const payloadSchema = signalProcessingPayloadSchema;
const actor = { kind: "system", component: "detection" } as const;
/** A newer active observation after this alert recovered is a relapse, even if it predates resolution. */
const relapses = (alert: AlertState | undefined, signal: SignalEvent) =>
  alert !== undefined &&
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
/** A signal observed before a manual resolution stays resolved unless it is a relapse. */
const stillResolved = (
  resolvedAt: string,
  signal: SignalEvent,
  current: AlertState | undefined,
) =>
  Date.parse(signal.observedAt) <= Date.parse(resolvedAt) &&
  !relapses(current, signal);
function assertSignalClaim(
  claimed: { queue: string; kind: string; id: string; payload: unknown },
  signal: SignalEvent,
): void {
  if (
    claimed.queue !== "job" ||
    claimed.kind !== "signal.process" ||
    claimed.id !== `signal.process:${signal.id}` ||
    payloadSchema.parse(claimed.payload).signalId !== signal.id
  )
    throw new Error("Invalid signal processing claim");
}
/** Opens a page for an active signal under its enabled escalation policy; undefined when none is bound. */
async function openSignalIncident(
  tx: DetectionTransaction,
  signal: SignalEvent,
  key: string,
) {
  const binding = await tx.detection.binding(
    signal.serviceId,
    signal.environmentId,
  );
  const policy =
    binding?.enabled && binding.policyId
      ? await tx.configuration.policies.get(binding.policyId)
      : undefined;
  if (!policy?.enabled || policy.serviceId !== signal.serviceId)
    return undefined;
  const id = pagingWorkId(tx.workspaceId, "signal-incident", key, signal.id);
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
  const incident = await tx.incidents.get(id);
  if (!incident) throw new Error("Page creation did not persist its incident");
  return incident;
}
/**
 * Reads the signal's alert and locks its group and the pages of its incidents. Manual resolution takes the same
 * page lock, so the alert's incident is re-read after acquiring it.
 */
async function lockAlertContext(
  tx: DetectionTransaction,
  signal: SignalEvent,
  source: Parameters<typeof alertGroupKey>[1],
) {
  const current = await tx.detection.alert(alertIdentity(signal));
  let previousIncident = current?.incidentId
    ? await tx.incidents.get(current.incidentId)
    : undefined;
  const key =
    current?.incidentId && !previousIncident?.resolvedAt
      ? current.groupKey
      : alertGroupKey(signal, source);
  const group = await tx.detection.lockGroup(key);
  if (current?.incidentId) {
    await tx.pages.lock(
      pagingWorkId(tx.workspaceId, "page", current.incidentId),
    );
    previousIncident = await tx.incidents.get(current.incidentId);
    if (!previousIncident) throw new Error("Alert incident is missing");
  }
  if (group?.incidentId && group.incidentId !== current?.incidentId)
    await tx.pages.lock(pagingWorkId(tx.workspaceId, "page", group.incidentId));
  return { current, previousIncident, key, group };
}
/** Writes the next group revision and the alert, schedules recovery for an incident, and records the receipt. */
async function persistAlertDecision(
  tx: DetectionTransaction,
  signal: SignalEvent,
  key: string,
  group: AlertGroup | undefined,
  incident: { id: string } | undefined,
  alert: AlertState,
) {
  const next: AlertGroup = {
    id: key,
    workspaceId: tx.workspaceId,
    serviceId: signal.serviceId,
    environmentId: signal.environmentId,
    revision: (group?.revision ?? 0) + 1,
    incidentId: incident?.id ?? null,
    recoveryJobId: null,
  };
  if (group?.recoveryJobId) await tx.work.cancel("job", [group.recoveryJobId]);
  if (!(await tx.detection.putGroup(next, group?.revision ?? null)))
    throw new Error("Locked group revision changed");
  await tx.detection.putAlert({ ...alert, incidentId: incident?.id ?? null });
  if (incident)
    await scheduleRecovery(tx, next, await recoveryDeadline(tx, incident.id));
  await receipt(
    tx,
    signal,
    alert.active ? "active" : "recovered",
    incident?.id ?? null,
  );
}
/** Records a manually resolved receipt when the signal does not reopen the resolved incident. */
async function recordIfStillResolved(
  tx: DetectionTransaction,
  signal: SignalEvent,
  incident: { id: string; resolvedAt?: string | null } | undefined,
  current: AlertState | undefined,
): Promise<boolean> {
  if (
    !incident?.resolvedAt ||
    !stillResolved(incident.resolvedAt, signal, current)
  )
    return false;
  await receipt(tx, signal, "manually_resolved", incident.id);
  return true;
}
async function groupIncident(
  tx: DetectionTransaction,
  group: AlertGroup | undefined,
) {
  if (!group?.incidentId) return undefined;
  const incident = await tx.incidents.get(group.incidentId);
  if (!incident) throw new Error("Group incident is missing");
  return incident;
}
async function loadSignal(tx: DetectionTransaction, signalId: string) {
  const signal = await tx.signals.get(signalId);
  if (!signal) throw new Error("Signal job references a missing event");
  const source = await tx.sources.get(signal.sourceId);
  if (!source) throw new Error("Signal job references a missing source");
  return { signal, source };
}
/** Only persisted events and claimed work may open pages. Receipt and page share the transaction. */
export class SignalProcessing {
  constructor(private readonly repository: DetectionRepository) {}
  process(lease: WorkLease): Promise<WorkResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const { signal, source } = await loadSignal(tx, hint.signalId);
      const locked = await lockAlertContext(tx, signal, source);
      const { key, previousIncident } = locked;
      let { current } = locked;
      const { group } = locked;
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      assertSignalClaim(claimed, signal);
      if (await tx.detection.processed(signal.id))
        return { state: "completed" };
      if (await recordIfStillResolved(tx, signal, previousIncident, current))
        return { state: "completed" };
      // A relapse after resolution starts a new incident for the same alert.
      if (previousIncident?.resolvedAt)
        current = current ? { ...current, incidentId: null } : undefined;
      const service = await tx.services.get(signal.serviceId);
      const decision = transitionAlert(
        current,
        signal,
        { ...source, enabled: source.enabled && Boolean(service?.enabled) },
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
      let incident = await groupIncident(tx, group);
      if (await recordIfStillResolved(tx, signal, incident, current))
        return { state: "completed" };
      if (incident?.resolvedAt) incident = undefined;
      if (!incident && decision.alert.active) {
        incident = await openSignalIncident(tx, signal, key);
        if (!incident) {
          await receipt(tx, signal, "unbound", null);
          return { state: "completed" };
        }
      }
      await persistAlertDecision(
        tx,
        signal,
        key,
        group,
        incident,
        decision.alert,
      );
      return { state: "completed" };
    });
  }
}
