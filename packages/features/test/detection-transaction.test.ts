import test from "node:test";
import assert from "node:assert/strict";
import {
  signalEventSchema,
  signalSourceSchema,
  workspaceIdSchema,
} from "../src/contracts/index.js";
import {
  serviceEnvironmentSchema,
  type AlertGroup,
  type AlertState,
  type ProcessedSignal,
  type ServiceEnvironment,
} from "../src/contracts/alerts.js";
import { transitionAlert } from "../src/domain/alerts/transition.js";
import { detectionTransaction } from "../src/application/detection/transaction.js";
import type { DetectionRecordStore } from "../src/application/detection/ports.js";
import type { ConfigurationTransaction } from "../src/application/configuration/ports.js";
import type { SignalTransaction } from "../src/application/signals/ports.js";
import { TransactionGuard } from "../src/application/ports/transaction-guard.js";
const now = "2026-10-02T00:00:00.000Z";
function fixture() {
  const scope = workspaceIdSchema.parse("workspace");
  const event = signalEventSchema.parse({
    id: "event",
    eventId: "event",
    version: 1,
    workspaceId: scope,
    sourceId: "source",
    serviceId: "service",
    environmentId: "production",
    fingerprint: "errors",
    observedAt: now,
    receivedAt: now,
    status: "active",
    severity: "high",
    title: "Errors",
    evidence: { summary: "HTTP 500", attributes: [] },
  });
  const source = signalSourceSchema.parse({
    id: "source",
    workspaceId: scope,
    serviceId: "service",
    environmentId: "production",
    name: "Source",
    kind: "generic",
    enabled: true,
    version: 1,
    grouping: "fingerprint",
    recovery: "explicit",
    recoveryHoldSeconds: 60,
    authSecretId: null,
    createdAt: now,
    updatedAt: now,
  });
  const decision = transitionAlert(undefined, event, source, now);
  if (decision.state !== "changed") throw new Error("Expected alert");
  const alert = decision.alert;
  const group: AlertGroup = {
    id: alert.groupKey,
    workspaceId: scope,
    serviceId: event.serviceId,
    environmentId: event.environmentId,
    revision: 1,
    incidentId: null,
    recoveryJobId: null,
  };
  const groups = new Map<string, AlertGroup>();
  const alerts = new Map<string, AlertState>();
  const receipts = new Map<string, ProcessedSignal>();
  let binding: ServiceEnvironment | undefined;
  let resolved = false;
  let policyService = "service";
  const copy = <T>(value: T): T => structuredClone(value);
  const store: DetectionRecordStore = {
    binding: async () => copy(binding),
    bindings: async () => ({
      items: binding ? [copy(binding)] : [],
      next: null,
    }),
    putBinding: async (value, expected) => {
      if ((binding?.version ?? null) !== expected) return false;
      binding = copy(value);
      return true;
    },
    lockGroup: async (key) => copy(groups.get(key)),
    putGroup: async (value, expected) => {
      if ((groups.get(value.id)?.revision ?? null) !== expected) return false;
      groups.set(value.id, copy(value));
      return true;
    },
    alert: async (id) => copy(alerts.get(id)),
    putAlert: async (value) => {
      alerts.set(value.id, copy(value));
    },
    forIncident: async (id) => ({
      items: copy(
        [...alerts.values()].filter((value) => value.incidentId === id),
      ),
      next: null,
    }),
    processed: async (id) => copy(receipts.get(id)),
    recordProcessed: async (value) => {
      if (receipts.has(value.id)) throw new Error("duplicate receipt");
      receipts.set(value.id, copy(value));
    },
  };
  // Minimal trusted host reads; these unit tests exercise shared guards, not SQL atomicity.
  const base = {
    workspaceId: scope,
    now,
    services: {
      get: async (id: string) =>
        id === "service" ? { id, workspaceId: scope } : undefined,
    },
    environments: {
      get: async (id: string) =>
        id === "production" ? { id, workspaceId: scope } : undefined,
    },
    configuration: {
      policies: {
        get: async (id: string) =>
          id === "policy"
            ? { id, serviceId: policyService, enabled: true }
            : undefined,
      },
    },
    incidents: {
      get: async (id: string) =>
        id === "incident"
          ? {
              id,
              serviceId: "service",
              environmentId: "production",
              resolvedAt: resolved ? now : null,
            }
          : undefined,
    },
    signals: {
      get: async (id: string) => (id === event.id ? copy(event) : undefined),
    },
  } as unknown as ConfigurationTransaction & SignalTransaction;
  const guard = new TransactionGuard();
  const tx = detectionTransaction(base, store, guard);
  return {
    scope,
    alert,
    group,
    groups,
    alerts,
    receipts,
    tx,
    guard,
    resolve: () => {
      resolved = true;
    },
    wrongPolicy: () => {
      policyService = "foreign-service";
    },
  };
}
test("groups require a lock and compare-and-swap revisions; caught failures poison the handle", async () => {
  const f = fixture();
  await assert.rejects(f.tx.detection.putGroup(f.group, null), {
    code: "group_not_locked",
  });
  await assert.rejects(f.tx.detection.lockGroup(f.group.id), {
    code: "group_not_locked",
  });
  assert.equal(f.groups.size, 0);
  const valid = fixture();
  assert.equal(await valid.tx.detection.lockGroup(valid.group.id), undefined);
  assert.equal(await valid.tx.detection.putGroup(valid.group, null), true);
  assert.equal(await valid.tx.detection.putGroup(valid.group, null), false);
  assert.equal(
    await valid.tx.detection.putGroup({ ...valid.group, revision: 2 }, 1),
    true,
  );
  valid.guard.close();
  await assert.rejects(valid.tx.detection.lockGroup(valid.group.id), {
    code: "closed_transaction",
  });
});
test("automatic policy bindings are explicit, scoped and versioned", async () => {
  const f = fixture();
  const binding = serviceEnvironmentSchema.parse({
    id: "binding",
    workspaceId: f.scope,
    serviceId: "service",
    environmentId: "production",
    version: 1,
    enabled: true,
    policyId: "policy",
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(await f.tx.detection.putBinding(binding, null), true);
  assert.equal(await f.tx.detection.putBinding(binding, null), false);
  assert.equal(
    await f.tx.detection.putBinding(
      { ...binding, version: 2, enabled: false, policyId: null },
      1,
    ),
    true,
  );
  const foreign = fixture();
  foreign.wrongPolicy();
  await assert.rejects(foreign.tx.detection.putBinding(binding, null), {
    code: "scope_violation",
  });
  assert.throws(() =>
    serviceEnvironmentSchema.parse({ ...binding, policyId: null }),
  );
  const scope = fixture();
  await assert.rejects(
    scope.tx.detection.putBinding(
      { ...binding, workspaceId: workspaceIdSchema.parse("foreign") },
      null,
    ),
    { code: "scope_violation" },
  );
});
test("alert watermarks must reference their immutable scoped signal", async () => {
  const f = fixture();
  await f.tx.detection.lockGroup(f.group.id);
  await f.tx.detection.putGroup(f.group, null);
  await f.tx.detection.putAlert(f.alert);
  assert.deepEqual(await f.tx.detection.alert(f.alert.id), f.alert);
  await assert.rejects(
    f.tx.detection.putAlert({ ...f.alert, fingerprint: "another" }),
    { code: "scope_violation" },
  );
});
test("an active incident cannot lose an alert through a changed link", async () => {
  const f = fixture();
  f.alerts.set(f.alert.id, { ...f.alert, incidentId: "incident" });
  await f.tx.detection.lockGroup(f.group.id);
  await f.tx.detection.putGroup(f.group, null);
  await assert.rejects(f.tx.detection.putAlert(f.alert), {
    code: "identity_change",
  });
  const resolved = fixture();
  resolved.alerts.set(resolved.alert.id, {
    ...resolved.alert,
    incidentId: "incident",
  });
  resolved.resolve();
  await resolved.tx.detection.lockGroup(resolved.group.id);
  await resolved.tx.detection.putGroup(resolved.group, null);
  await resolved.tx.detection.putAlert(resolved.alert);
  assert.equal(resolved.alerts.get(resolved.alert.id)?.incidentId, null);
});
test("processing receipts retain signal scope and invalid pages cannot reach storage", async () => {
  const f = fixture();
  await f.tx.detection.recordProcessed({
    id: "event",
    workspaceId: f.scope,
    sourceId: "source",
    incidentId: null,
    disposition: "stale",
    recordedAt: now,
  });
  assert.equal((await f.tx.detection.processed("event"))?.disposition, "stale");
  await assert.rejects(
    f.tx.detection.recordProcessed({
      id: "event",
      workspaceId: f.scope,
      sourceId: "foreign-source",
      incidentId: null,
      disposition: "active",
      recordedAt: now,
    }),
    { code: "scope_violation" },
  );
  const other = fixture();
  await assert.rejects(
    other.tx.detection.forIncident("incident", { limit: 101 }),
    { code: "invalid_page" },
  );
});
