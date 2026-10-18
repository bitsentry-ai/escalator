import test from "node:test";
import assert from "node:assert/strict";
import {
  signalSourceSchema,
  signalEventSchema,
} from "../src/contracts/index.js";
import type { AlertState } from "../src/contracts/alerts.js";
import {
  alertIdentity,
  alertGroupKey,
  transitionAlert,
  incidentRecoveryDeadline,
} from "../src/domain/alerts/transition.js";
const at = "2026-10-02T00:00:00.000Z";
const later = (seconds: number) =>
  new Date(Date.parse(at) + seconds * 1000).toISOString();
const source = signalSourceSchema.parse({
  id: "source",
  workspaceId: "workspace",
  serviceId: "service",
  environmentId: "production",
  name: "Errors",
  kind: "generic",
  enabled: true,
  version: 1,
  grouping: "source-fingerprint",
  recovery: "explicit",
  recoveryHoldSeconds: 60,
  authSecretId: null,
  createdAt: at,
  updatedAt: at,
});
function signal(
  id: string,
  seconds: number,
  status: "active" | "recovered" = "active",
) {
  return signalEventSchema.parse({
    id,
    eventId: id,
    version: 1,
    workspaceId: source.workspaceId,
    serviceId: source.serviceId,
    environmentId: source.environmentId,
    sourceId: source.id,
    fingerprint: "checkout-error",
    observedAt: later(seconds),
    receivedAt: later(seconds + 1),
    status,
    severity: "high",
    title: "Checkout errors",
    evidence: { summary: "HTTP 500", attributes: [] },
  });
}
function changed(
  previous: AlertState | undefined,
  event = signal("first", 0),
  now = later(10),
): AlertState {
  const result = transitionAlert(previous, event, source, now);
  assert.equal(result.state, "changed");
  if (result.state !== "changed") throw new Error("Expected changed");
  return result.alert;
}
test("grouping never merges all service alerts or crosses service/environment/workspace boundaries", () => {
  const event = signal("first", 0);
  const base = alertGroupKey(event, source);
  assert.notEqual(
    alertGroupKey({ ...event, fingerprint: "other" }, source),
    base,
  );
  for (const key of ["workspaceId", "serviceId", "environmentId"] as const) {
    const other = { ...event, [key]: "other" } as typeof event;
    assert.notEqual(
      alertGroupKey(other, { ...source, [key]: "other" } as typeof source),
      base,
    );
    assert.throws(() => alertGroupKey(other, source), /scope differs/);
  }
  const other = { ...event, sourceId: "second" };
  assert.notEqual(alertGroupKey(other, { ...source, id: "second" }), base);
  const common = { ...source, grouping: "fingerprint" as const };
  assert.equal(
    alertGroupKey(event, common),
    alertGroupKey(other, { ...common, id: "second" }),
  );
  assert.notEqual(alertIdentity(event), alertIdentity(other));
});
test("recovery must be newer than the last active observation and cannot be inferred from silence", () => {
  const active = changed(undefined, signal("first", 20), later(30));
  assert.equal(
    incidentRecoveryDeadline([{ ...active, incidentId: "incident" }]),
    null,
  );
  for (const seconds of [0, 19, 20])
    assert.deepEqual(
      transitionAlert(
        active,
        signal(`recovery-${seconds}`, seconds, "recovered"),
        source,
        later(100),
      ),
      { state: "ignored", reason: "stale" },
    );
  const recovered = changed(
    active,
    signal("recovered", 21, "recovered"),
    later(100),
  );
  assert.equal(recovered.active, false);
  assert.equal(recovered.recoveredAt, later(100));
});
test("equal-time ambiguity conservatively preserves active state regardless of delivery order", () => {
  const event = signal("active", 10);
  const recovery = signal("recovery", 10, "recovered");
  const firstRecovery = changed(undefined, recovery);
  assert.equal(changed(firstRecovery, event).active, true);
  const firstActive = changed(undefined, event);
  assert.deepEqual(transitionAlert(firstActive, recovery, source, later(10)), {
    state: "ignored",
    reason: "stale",
  });
});
test("duplicate IDs and stale active observations cannot reopen a recovered alert", () => {
  const current = changed(
    undefined,
    signal("recovered", 20, "recovered"),
    later(30),
  );
  assert.deepEqual(
    transitionAlert(current, signal("active", 10), source, later(30)),
    { state: "ignored", reason: "stale" },
  );
  assert.deepEqual(
    transitionAlert(current, signal("recovered", 40), source, later(40)),
    { state: "ignored", reason: "duplicate" },
  );
});
test("manual tracker recovery and disabled/future events do not manufacture health", () => {
  const current = changed(undefined);
  assert.deepEqual(
    transitionAlert(
      current,
      signal("recovery", 10, "recovered"),
      { ...source, recovery: "manual" },
      later(20),
    ),
    { state: "ignored", reason: "manual_recovery" },
  );
  assert.deepEqual(
    transitionAlert(
      current,
      signal("later", 10),
      { ...source, enabled: false },
      later(20),
    ),
    { state: "ignored", reason: "disabled" },
  );
  assert.deepEqual(
    transitionAlert(current, signal("future", 301), source, at),
    { state: "ignored", reason: "future" },
  );
  assert.equal(
    transitionAlert(current, signal("limit", 300), source, at).state,
    "changed",
  );
});
test("all contributing alerts must recover and each hold must expire", () => {
  const recovered = {
    ...changed(undefined, signal("recovered", 10, "recovered"), later(20)),
    incidentId: "incident",
  };
  const peer = {
    ...recovered,
    id: "peer",
    sourceId: "peer-source",
    recoveredAt: later(40),
    recoveryHoldSeconds: 120,
  };
  assert.equal(incidentRecoveryDeadline([]), null);
  assert.equal(
    incidentRecoveryDeadline([
      recovered,
      { ...peer, active: true, recoveredAt: null },
    ]),
    null,
  );
  assert.equal(incidentRecoveryDeadline([recovered, peer]), later(160));
  assert.throws(
    () =>
      incidentRecoveryDeadline([recovered, { ...peer, incidentId: "other" }]),
    /group differs/,
  );
  assert.throws(
    () => incidentRecoveryDeadline([recovered, { ...peer, groupKey: "other" }]),
    /group differs/,
  );
});
test("repeated healthy observations do not postpone an already running recovery hold", () => {
  const first = {
    ...changed(undefined, signal("recovered", 10, "recovered"), later(20)),
    incidentId: "incident",
  };
  const second = changed(
    first,
    signal("still-recovered", 30, "recovered"),
    later(40),
  );
  assert.equal(second.recoveredAt, later(20));
  assert.equal(incidentRecoveryDeadline([second]), later(80));
  const relapse = changed(second, signal("relapse", 50), later(60));
  assert.equal(relapse.recoveredAt, null);
  assert.equal(incidentRecoveryDeadline([relapse]), null);
  const recoveredAgain = changed(
    relapse,
    signal("recovered-again", 70, "recovered"),
    later(80),
  );
  assert.equal(incidentRecoveryDeadline([recoveredAgain]), later(140));
});
test("source grouping edits cannot move a contributing alert to another active incident", () => {
  const previous = { ...changed(undefined), incidentId: "incident" };
  const edited = { ...source, grouping: "fingerprint" as const, version: 2 };
  const result = transitionAlert(
    previous,
    signal("next", 20),
    edited,
    later(30),
  );
  assert.equal(result.state, "changed");
  if (result.state === "changed") {
    assert.equal(result.alert.groupKey, previous.groupKey);
    assert.equal(result.alert.sourceVersion, 2);
  }
  const detached = transitionAlert(
    { ...previous, incidentId: null },
    signal("next", 20),
    edited,
    later(30),
  );
  if (detached.state === "changed")
    assert.notEqual(detached.alert.groupKey, previous.groupKey);
});

test("reordered active and recovery observations converge on the newest state", () => {
  const events = [
    signal("active", 10),
    signal("recovered", 20, "recovered"),
    signal("relapse", 30),
  ];
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    let state: AlertState | undefined;
    for (const index of order) {
      const result = transitionAlert(state, events[index], source, later(40));
      if (result.state === "changed") state = result.alert;
    }
    assert.equal(state?.active, true);
    assert.equal(state?.lastSignalId, "relapse");
  }
});
