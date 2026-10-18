import test from "node:test";
import assert from "node:assert/strict";
import { ReplayCoverageReader } from "../src/application/retention/reader.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
import type { ReplayCoverageSnapshot } from "../src/contracts/replay-reader.js";
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 3, 0, minute)).toISOString();
const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("workspace"),
  responderId: responderIdSchema.parse("responder"),
  role: "administrator",
};
const query = {
  kind: "probe" as const,
  id: "probe",
  startAt: at(0),
  endAt: at(4),
  visibleAt: at(5),
};
const snapshot = (): ReplayCoverageSnapshot => ({
  workspaceId: actor.workspaceId,
  kind: "probe",
  streamId: "probe",
  snapshotAt: at(6),
  complete: true,
  configurations: [
    {
      version: 1,
      effectiveAt: at(0),
      recordedAt: at(0),
      enabled: true,
      anchorAt: at(0),
      stepSeconds: 60,
    },
  ],
  receipts: Array.from({ length: 4 }, (_, n) => ({
    id: `r${n}`,
    version: 1,
    slotAt: at(n),
    observedAt: at(n),
    receivedAt: at(n),
    usable: true,
  })),
});
const read = (data: ReplayCoverageSnapshot, input = query) =>
  new ReplayCoverageReader({ snapshot: async () => data }).read(actor, input);
test("coverage reader uses immutable cadence metadata and retains interior holes", async () => {
  const data = snapshot();
  data.receipts.splice(1, 1);
  const result = await read(data);
  assert.deepEqual(result.report, {
    coverageVersion: 1,
    expectedSlots: 4,
    availableSlots: 3,
    queryComplete: true,
    gaps: [{ startAt: at(1), endAt: at(2), reason: "missing" }],
  });
});
test("migration captures cannot establish coverage before the capture", async () => {
  const data = snapshot();
  data.configurations[0]!.effectiveAt = at(2);
  data.configurations[0]!.recordedAt = at(2);
  const result = await read(data);
  assert.ok("gaps" in result.report);
  assert.deepEqual(result.report.gaps, [
    { startAt: at(0), endAt: at(2), reason: "configuration_unknown" },
  ]);
});
test("old unscheduled receipts are counted separately and cannot fill slots", async () => {
  const data = snapshot();
  data.receipts[0]!.slotAt = null;
  data.receipts[0]!.version = null;
  data.receipts[0]!.receivedAt = null;
  const result = await read(data);
  assert.equal(result.unassignedReceipts, 1);
  assert.ok("gaps" in result.report);
  assert.deepEqual(result.report.gaps, [
    { startAt: at(0), endAt: at(1), reason: "missing" },
  ]);
});
test("a delayed probe is unusable for its earlier scheduled bucket", async () => {
  const data = snapshot();
  data.receipts[0]!.observedAt = at(2);
  data.receipts[0]!.receivedAt = at(2);
  const result = await read(data);
  assert.ok("gaps" in result.report);
  assert.deepEqual(result.report.gaps, [
    { startAt: at(0), endAt: at(1), reason: "unusable" },
  ]);
});
test("scope, kind and identity mismatch fail closed", async () => {
  for (const patch of [
    { workspaceId: workspaceIdSchema.parse("other") },
    { streamId: "other" },
    { kind: "metric" as const },
  ])
    await assert.rejects(read({ ...snapshot(), ...patch }), /scope_violation/);
});
test("future cutoffs and duplicate receipts are rejected", async () => {
  await assert.rejects(read({ ...snapshot(), snapshotAt: at(4) }), /Future/);
  const data = snapshot();
  data.receipts.push(data.receipts[0]!);
  await assert.rejects(read(data), /Duplicate/);
});
test("truncated snapshots never advertise coverage from a successful prefix", async () => {
  const result = await read({ ...snapshot(), complete: false });
  assert.ok("gaps" in result.report);
  assert.deepEqual(result.report.gaps, [
    { startAt: at(0), endAt: at(4), reason: "query_truncated" },
  ]);
});
test("configuration clocks moving backward report unknown history, not query truncation", async () => {
  const data = snapshot();
  data.configurations.push({
    ...data.configurations[0]!,
    version: 2,
    effectiveAt: at(-1),
  });
  const result = await read(data);
  assert.equal(result.report.queryComplete, true);
  assert.ok("gaps" in result.report);
  assert.deepEqual(result.report.gaps, [
    { startAt: at(0), endAt: at(4), reason: "configuration_unknown" },
  ]);
});

test("unassigned receipts outside the window are rejected instead of counted", async () => {
  const data = snapshot();
  data.receipts[0]!.slotAt = null;
  data.receipts[0]!.version = null;
  data.receipts[0]!.observedAt = at(-1);
  await assert.rejects(read(data), /outside requested window/);
});
