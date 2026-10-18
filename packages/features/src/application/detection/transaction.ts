import {
  alertGroupSchema,
  alertStateSchema,
  processedSignalSchema,
  serviceEnvironmentSchema,
} from "../../contracts/alerts.js";
import type { AlertGroup } from "../../contracts/alerts.js";
import { opaqueIdSchema } from "../../contracts/index.js";
import { alertIdentity } from "../../domain/alerts/transition.js";
import { PersistenceError, type PageRequest } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { ConfigurationTransaction } from "../configuration/ports.js";
import type { SignalTransaction } from "../signals/ports.js";
import type { DetectionRecordStore, DetectionTransaction } from "./ports.js";
export class DetectionError extends Error {
  constructor(
    readonly code:
      | "invalid_version"
      | "identity_change"
      | "group_not_locked"
      | "invalid_binding"
      | "invalid_timestamp",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function page(value: PageRequest) {
  if (
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    (value.after !== undefined &&
      !opaqueIdSchema.safeParse(value.after).success)
  )
    throw new PersistenceError("invalid_page");
}
/** Validation and transaction poisoning are shared; hosts supply only scoped SQL primitives. */
export function detectionTransaction(
  base: ConfigurationTransaction & SignalTransaction,
  store: DetectionRecordStore,
  guard: TransactionGuard,
): DetectionTransaction {
  const groups = new Map<string, AlertGroup | undefined>();
  function scoped(value: { workspaceId: string }) {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  }
  function locked(key: string) {
    if (!groups.has(key)) throw new DetectionError("group_not_locked");
  }
  return {
    ...base,
    detection: {
      binding: (serviceId, environmentId) =>
        guard.operation(() =>
          store.binding(
            opaqueIdSchema.parse(serviceId),
            opaqueIdSchema.parse(environmentId),
          ),
        ),
      bindings: (input) =>
        guard.operation(() => {
          page(input);
          return store.bindings(input);
        }),
      putBinding: (input, expected) =>
        guard.operation(async () => {
          const value = serviceEnvironmentSchema.parse(input);
          scoped(value);
          if (
            Date.parse(value.updatedAt) !== Date.parse(base.now) ||
            (expected === null &&
              Date.parse(value.createdAt) !== Date.parse(base.now))
          )
            throw new DetectionError("invalid_timestamp");
          if (
            value.version !== (expected ?? 0) + 1 ||
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1))
          )
            throw new DetectionError("invalid_version");
          required(await base.services.get(value.serviceId));
          required(await base.environments.get(value.environmentId));
          if (value.policyId !== null) {
            const policy = required(
              await base.configuration.policies.get(value.policyId),
            );
            if (policy.serviceId !== value.serviceId)
              throw new PersistenceError("scope_violation");
            if (value.enabled && !policy.enabled)
              throw new DetectionError("invalid_binding");
          }
          const current = await store.binding(
            value.serviceId,
            value.environmentId,
            true,
          );
          if ((current?.version ?? null) !== expected) return false;
          if (
            current &&
            (current.id !== value.id || current.createdAt !== value.createdAt)
          )
            throw new DetectionError("identity_change");
          return store.putBinding(value, expected);
        }),
      lockGroup: (key) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(key);
          const value = await store.lockGroup(key);
          groups.set(key, value);
          return value;
        }),
      putGroup: (input, expected) =>
        guard.operation(async () => {
          const value = alertGroupSchema.parse(input);
          scoped(value);
          locked(value.id);
          if (
            value.revision !== (expected ?? 0) + 1 ||
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1))
          )
            throw new DetectionError("invalid_version");
          const previous = groups.get(value.id);
          if ((previous?.revision ?? null) !== expected) return false;
          if (
            previous &&
            (previous.serviceId !== value.serviceId ||
              previous.environmentId !== value.environmentId)
          )
            throw new DetectionError("identity_change");
          required(await base.services.get(value.serviceId));
          required(await base.environments.get(value.environmentId));
          if (value.incidentId !== null) {
            const incident = required(
              await base.incidents.get(value.incidentId),
            );
            if (
              incident.serviceId !== value.serviceId ||
              incident.environmentId !== value.environmentId
            )
              throw new PersistenceError("scope_violation");
          }
          if (
            previous?.incidentId &&
            previous.incidentId !== value.incidentId
          ) {
            const incident = required(
              await base.incidents.get(previous.incidentId),
            );
            if (incident.resolvedAt === null)
              throw new DetectionError("identity_change");
          }
          const written = await store.putGroup(value, expected);
          if (written) groups.set(value.id, value);
          return written;
        }),
      alert: (id) =>
        guard.operation(() => store.alert(opaqueIdSchema.parse(id))),
      putAlert: (input) =>
        guard.operation(async () => {
          const value = alertStateSchema.parse(input);
          scoped(value);
          locked(value.groupKey);
          const group = required(groups.get(value.groupKey));
          if (
            group.serviceId !== value.serviceId ||
            group.environmentId !== value.environmentId ||
            group.incidentId !== value.incidentId
          )
            throw new PersistenceError("scope_violation");
          const event = required(await base.signals.get(value.lastSignalId));
          if (
            value.id !== alertIdentity(event) ||
            value.sourceId !== event.sourceId ||
            value.serviceId !== event.serviceId ||
            value.environmentId !== event.environmentId ||
            value.fingerprint !== event.fingerprint ||
            value.observedAt !== event.observedAt ||
            value.receivedAt !== event.receivedAt
          )
            throw new PersistenceError("scope_violation");
          const current = await store.alert(value.id);
          if (current?.incidentId && current.incidentId !== value.incidentId) {
            const previousIncident = required(
              await base.incidents.get(current.incidentId),
            );
            if (previousIncident.resolvedAt === null)
              throw new DetectionError("identity_change");
          }
          await store.putAlert(value);
        }),
      forIncident: (id, input) =>
        guard.operation(() => {
          opaqueIdSchema.parse(id);
          page(input);
          return store.forIncident(id, input);
        }),
      processed: (id) =>
        guard.operation(() => store.processed(opaqueIdSchema.parse(id))),
      recordProcessed: (input) =>
        guard.operation(async () => {
          const value = processedSignalSchema.parse(input);
          scoped(value);
          if (Date.parse(value.recordedAt) !== Date.parse(base.now))
            throw new DetectionError("invalid_timestamp");
          const event = required(await base.signals.get(value.id));
          if (event.sourceId !== value.sourceId)
            throw new PersistenceError("scope_violation");
          if (value.incidentId !== null) {
            const incident = required(
              await base.incidents.get(value.incidentId),
            );
            if (
              incident.serviceId !== event.serviceId ||
              incident.environmentId !== event.environmentId
            )
              throw new PersistenceError("scope_violation");
          }
          await store.recordProcessed(value);
        }),
    },
  };
}
