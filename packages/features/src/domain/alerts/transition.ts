import { createHash } from "node:crypto";
import type { SignalEvent, SignalSource } from "../../contracts/index.js";
import { alertStateSchema, type AlertState } from "../../contracts/alerts.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { expectDefined } from "../../contracts/expect-defined.js";
const hash = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
type AlertIdentityFields = Pick<
  SignalEvent,
  "workspaceId" | "serviceId" | "environmentId" | "sourceId" | "fingerprint"
>;
/** Cross-source grouping still preserves workspace, service, environment and fingerprint. */
export function alertGroupKey(
  signal: AlertIdentityFields,
  source: SignalSource,
): string {
  if (
    source.workspaceId !== signal.workspaceId ||
    source.id !== signal.sourceId ||
    source.serviceId !== signal.serviceId ||
    source.environmentId !== signal.environmentId
  )
    throw new Error("Signal source scope differs");
  return hash([
    "alert-group",
    signal.workspaceId,
    signal.serviceId,
    signal.environmentId,
    signal.fingerprint,
    source.grouping === "source-fingerprint" ? source.id : null,
  ]);
}
export function alertIdentity(signal: AlertIdentityFields): string {
  return hash([
    "alert",
    signal.workspaceId,
    signal.serviceId,
    signal.environmentId,
    signal.sourceId,
    signal.fingerprint,
  ]);
}
export type AlertTransition =
  | {
      state: "ignored";
      reason: "disabled" | "future" | "stale" | "duplicate" | "manual_recovery";
    }
  | { state: "changed"; alert: AlertState };
/** No telemetry timeout is a recovery. The caller serializes the group and persists this decision. */
export function transitionAlert(
  current: AlertState | undefined,
  signal: SignalEvent,
  source: SignalSource,
  databaseNow: string,
): AlertTransition {
  const groupKey = alertGroupKey(signal, source);
  const id = alertIdentity(signal);
  const now = Date.parse(utcTimestampSchema.parse(databaseNow));
  if (current) {
    alertStateSchema.parse(current);
    if (
      current.id !== id ||
      current.workspaceId !== signal.workspaceId ||
      current.sourceId !== signal.sourceId ||
      current.fingerprint !== signal.fingerprint ||
      current.serviceId !== signal.serviceId ||
      current.environmentId !== signal.environmentId
    )
      throw new Error("Alert scope differs");
  }
  if (!source.enabled) return { state: "ignored", reason: "disabled" };
  if (Date.parse(signal.observedAt) > now + 300_000)
    return { state: "ignored", reason: "future" };
  if (signal.status === "recovered" && source.recovery === "manual")
    return { state: "ignored", reason: "manual_recovery" };
  if (current?.lastSignalId === signal.id)
    return { state: "ignored", reason: "duplicate" };
  if (current) {
    const order =
      Date.parse(signal.observedAt) - Date.parse(current.observedAt);
    // Active wins an equal-timestamp ambiguity; recovery must be strictly newer.
    if (
      order < 0 ||
      (order === 0 && (current.active || signal.status === "recovered"))
    )
      return { state: "ignored", reason: "stale" };
  }
  const active = signal.status === "active";
  return {
    state: "changed",
    alert: alertStateSchema.parse({
      id,
      workspaceId: signal.workspaceId,
      serviceId: signal.serviceId,
      environmentId: signal.environmentId,
      sourceId: signal.sourceId,
      fingerprint: signal.fingerprint,
      // Freeze grouping while contributing to an existing incident, even after a source edit.
      groupKey: current?.incidentId ? current.groupKey : groupKey,
      sourceVersion: source.version,
      lastSignalId: signal.id,
      observedAt: signal.observedAt,
      receivedAt: signal.receivedAt,
      active,
      recoveredAt: active
        ? null
        : current && !current.active
          ? current.recoveredAt
          : databaseNow,
      recoveryHoldSeconds: source.recoveryHoldSeconds,
      incidentId: current?.incidentId ?? null,
    }),
  };
}
/** Hold begins when recovery is processed using database time, not a provider timestamp. */
export function incidentRecoveryDeadline(
  alerts: readonly AlertState[],
): string | null {
  if (
    alerts.length === 0 ||
    alerts.some((alert) => alert.active || alert.recoveredAt === null)
  )
    return null;
  const first = alerts[0];
  for (const alert of alerts) {
    alertStateSchema.parse(alert);
    if (
      !first.incidentId ||
      alert.incidentId !== first.incidentId ||
      alert.workspaceId !== first.workspaceId ||
      alert.serviceId !== first.serviceId ||
      alert.environmentId !== first.environmentId ||
      alert.groupKey !== first.groupKey
    )
      throw new Error("Recovery group differs");
  }
  const deadline = alerts.reduce(
    (latest, alert) =>
      Math.max(
        latest,
        Date.parse(expectDefined(alert.recoveredAt, "recovery time")) +
          alert.recoveryHoldSeconds * 1000,
      ),
    0,
  );
  return new Date(deadline).toISOString();
}
