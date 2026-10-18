import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { probeJobId } from "../src/application/probes/schedule.js";
import { metricJobId } from "../src/application/metrics/schedule.js";
import {
  hasTerminalReceiptWork,
  type PruneReceiptIdentity,
  type PruneWorkRecord,
} from "../src/application/retention/terminal-work.js";
const scope = workspaceIdSchema.parse("scope"),
  dueAt = "2026-10-03T00:00:00.000Z";
const terminal = (
  id: string,
  kind: string,
  payload: unknown,
): PruneWorkRecord => ({
  id,
  kind,
  payload,
  state: "completed",
  leaseToken: null,
  leaseExpiresAt: null,
  completedAt: dueAt,
});
const probeId = probeJobId(scope, "probe", 1, dueAt);
const metricId = metricJobId(scope, "monitor", 1, dueAt);
const fixtures: [PruneReceiptIdentity, PruneWorkRecord][] = [
  [
    { kind: "signal", id: "event" },
    terminal("signal.process:event", "signal.process", { signalId: "event" }),
  ],
  [
    { kind: "probe", id: probeId, ownerId: "probe", version: 1 },
    terminal(probeId, "probe.execute", {
      probeId: "probe",
      probeVersion: 1,
      dueAt,
      secretIds: [],
    }),
  ],
  [
    { kind: "metric", id: metricId, ownerId: "monitor", version: 1 },
    terminal(metricId, "metrics.poll", {
      monitorId: "monitor",
      monitorVersion: 1,
      dueAt,
      secretIds: [],
    }),
  ],
];
test("only the matching completed execution supplies terminal receipt evidence", () => {
  for (const [receipt, work] of fixtures)
    assert.equal(hasTerminalReceiptWork(scope, receipt, work), true);
});
test("missing, live, retryable, failed and cancelled work keeps every receipt protected", () => {
  for (const [receipt, work] of fixtures) {
    assert.equal(hasTerminalReceiptWork(scope, receipt, undefined), false);
    for (const state of [
      "pending",
      "running",
      "failed",
      "cancelled",
      "unknown",
    ])
      assert.equal(
        hasTerminalReceiptWork(scope, receipt, { ...work, state }),
        false,
      );
  }
});
test("lease remnants and missing or invalid completion timestamps are not terminal evidence", () => {
  for (const [receipt, work] of fixtures)
    for (const patch of [
      { leaseToken: "still-owned" },
      { leaseExpiresAt: dueAt },
      { completedAt: null },
      { completedAt: "invalid" },
    ])
      assert.equal(
        hasTerminalReceiptWork(scope, receipt, { ...work, ...patch }),
        false,
      );
});
test("job kind, ID and payload must identify the selected receipt", () => {
  for (const [receipt, work] of fixtures) {
    assert.equal(
      hasTerminalReceiptWork(scope, receipt, { ...work, kind: "other" }),
      false,
    );
    assert.equal(
      hasTerminalReceiptWork(scope, receipt, { ...work, id: "other" }),
      false,
    );
    for (const payload of [
      null,
      {},
      [],
      { arbitrary: true },
      { ...(work.payload as object), extra: true },
    ])
      assert.equal(
        hasTerminalReceiptWork(scope, receipt, { ...work, payload }),
        false,
      );
  }
  assert.equal(
    hasTerminalReceiptWork(scope, fixtures[0]![0], {
      ...fixtures[0]![1],
      payload: { signalId: "other" },
    }),
    false,
  );
});
test("probe and metric work hashes bind scope, owner, revision and original scheduled slot", () => {
  for (const [receipt, work] of fixtures.slice(1)) {
    assert.equal(
      hasTerminalReceiptWork(workspaceIdSchema.parse("other"), receipt, work),
      false,
    );
    if (receipt.kind === "signal") throw new Error("Unexpected fixture");
    assert.equal(
      hasTerminalReceiptWork(scope, { ...receipt, ownerId: "other" }, work),
      false,
    );
    assert.equal(
      hasTerminalReceiptWork(scope, { ...receipt, version: 2 }, work),
      false,
    );
    assert.equal(
      hasTerminalReceiptWork(scope, receipt, {
        ...work,
        payload: {
          ...(work.payload as object),
          dueAt: "2026-10-03T00:01:00.000Z",
        },
      }),
      false,
    );
  }
});
