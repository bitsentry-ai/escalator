import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  deploymentWatchRecordSchema,
  deploymentBaselineStreamSchema,
  probeSchema,
  watchCadenceReceiptSchema,
} from "../src/contracts/index.js";
import {
  planWatchCadence,
  planWatchCadenceRestore,
} from "../src/application/deploy/cadence.js";
import { seedProbeFixture } from "./conformance/probes.js";
import { MemoryProbeRepository } from "./conformance/memory-probes.js";
const scope = workspaceIdSchema.parse("cadence"),
  at = (s: number) =>
    new Date(Date.parse("2026-10-05T00:00:00Z") + s * 1000).toISOString();
async function fixture() {
  const repo = new MemoryProbeRepository(() => new Date(at(0)));
  const seeded = await repo.transaction(scope, seedProbeFixture);
  const probe = probeSchema.parse({ ...seeded, intervalSeconds: 300 });
  const watch = deploymentWatchRecordSchema.parse({
    formatVersion: 1,
    workspaceId: scope,
    targetId: "target",
    deploymentId: "deployment",
    serviceId: probe.serviceId,
    environmentId: probe.environmentId,
    revision: 1,
    startedAt: at(0),
    endsAt: at(1800),
    updatedAt: at(0),
    evaluatedAt: null,
    finalizedAt: null,
    verdict: "PENDING",
    inventoryComplete: false,
    streams: [],
    firstFailure: null,
    incidentId: null,
    overlappingDeploymentIds: [],
    overlapInventoryComplete: false,
  });
  const captured = deploymentBaselineStreamSchema.parse({
    kind: "probe",
    id: probe.id,
    sourceId: probe.sourceId,
    configurationVersion: 1,
    measurementHash: "a".repeat(64),
    criteria: {
      version: 1,
      kind: "probe",
      baselineMinimumSamples: 3,
      failureThreshold: 1,
    },
    evidence: {
      workspaceId: scope,
      streamId: probe.id,
      startAt: at(-900),
      endAt: at(0),
      visibleAt: at(0),
      complete: true,
      configurationCompatible: true,
      segments: [],
      samples: [],
    },
  });
  return { probe, watch, captured };
}
test("cadence plan preserves the full probe configuration and records exact restoration ownership", async () => {
  const f = await fixture(),
    original = structuredClone(f);
  const plan = planWatchCadence(f.watch, f.captured, f.probe, undefined, at(1));
  assert.equal(plan.state, "tighten");
  if (plan.state !== "tighten") throw new Error();
  assert.equal(plan.probe.intervalSeconds, 60);
  assert.equal(plan.probe.version, 2);
  assert.deepEqual(plan.probe.config, f.probe.config);
  assert.equal(plan.lease.originalIntervalSeconds, 300);
  assert.equal(plan.lease.appliedProbeVersion, 2);
  assert.equal(plan.lease.restoreAt, at(1800));
  assert.deepEqual(f, original);
});
test("overlapping watch extends ownership without forgetting the original interval", async () => {
  const f = await fixture(),
    first = planWatchCadence(f.watch, f.captured, f.probe, undefined, at(1));
  if (first.state !== "tighten") throw new Error();
  const later = {
    ...f.watch,
    deploymentId: "second",
    startedAt: at(600),
    updatedAt: at(600),
    endsAt: at(2400),
  };
  const plan = planWatchCadence(
    later,
    f.captured,
    first.probe,
    first.lease,
    at(600),
  );
  assert.equal(plan.state, "join");
  if (plan.state !== "join") throw new Error();
  assert.equal(plan.lease.generationId, first.lease.generationId);
  assert.equal(plan.lease.appliedProbeVersion, first.probe.version);
  assert.equal(plan.lease.originalIntervalSeconds, 300);
  assert.equal(plan.lease.restoreAt, at(2400));
  assert.deepEqual(planWatchCadenceRestore(plan.lease, first.probe, at(1800)), {
    state: "wait",
    dueAt: at(2400),
  });
  const restored = planWatchCadenceRestore(plan.lease, first.probe, at(2400));
  assert.equal(restored.state, "restore");
  if (restored.state === "restore") {
    assert.equal(restored.probe.intervalSeconds, 300);
    assert.equal(restored.probe.version, 3);
  }
});
test("operator edits prevent both renewal and restoration even when the interval remains 60", async () => {
  const f = await fixture(),
    first = planWatchCadence(f.watch, f.captured, f.probe, undefined, at(1));
  if (first.state !== "tighten") throw new Error();
  const edited = {
    ...first.probe,
    version: 3,
    name: "Operator edited",
    updatedAt: at(10),
  };
  assert.deepEqual(
    planWatchCadence(f.watch, f.captured, edited, first.lease, at(10)),
    { state: "skip", decision: "superseded" },
  );
  assert.deepEqual(planWatchCadenceRestore(first.lease, edited, at(1800)), {
    state: "superseded",
  });
});
test("disabled, already fast and expired watches do not mutate probe cadence", async () => {
  const f = await fixture();
  assert.deepEqual(
    planWatchCadence(
      f.watch,
      f.captured,
      { ...f.probe, enabled: false },
      undefined,
      at(1),
    ),
    { state: "skip", decision: "disabled" },
  );
  assert.deepEqual(
    planWatchCadence(
      f.watch,
      f.captured,
      { ...f.probe, intervalSeconds: 60 },
      undefined,
      at(1),
    ),
    { state: "skip", decision: "already_fast" },
  );
  assert.deepEqual(
    planWatchCadence(f.watch, f.captured, f.probe, undefined, at(1800)),
    { state: "skip", decision: "expired" },
  );
});
test("cadence binding rejects foreign scope and a substituted captured probe", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      planWatchCadence(
        { ...f.watch, workspaceId: workspaceIdSchema.parse("other") },
        f.captured,
        f.probe,
        undefined,
        at(1),
      ),
    /scope_violation/,
  );
  assert.throws(
    () =>
      planWatchCadence(
        f.watch,
        { ...f.captured, id: "other" },
        f.probe,
        undefined,
        at(1),
      ),
    /scope_violation/,
  );
  assert.throws(
    () => planWatchCadence(f.watch, f.captured, f.probe, undefined, at(-1)),
    /backwards/,
  );
});
test("skipped cadence receipts cannot claim an applied lease or version", () => {
  const receipt = {
    workspaceId: scope,
    targetId: "target",
    deploymentId: "deployment",
    probeId: "probe",
    sourceId: "source",
    serviceId: "service",
    environmentId: "production",
    recordedAt: at(0),
    decision: "capacity_limited",
    generationId: null,
    appliedProbeVersion: null,
  };
  assert.ok(watchCadenceReceiptSchema.safeParse(receipt).success);
  assert.equal(
    watchCadenceReceiptSchema.safeParse({
      ...receipt,
      generationId: "generation",
      appliedProbeVersion: 2,
    }).success,
    false,
  );
  assert.equal(
    watchCadenceReceiptSchema.safeParse({ ...receipt, decision: "tightened" })
      .success,
    false,
  );
});

test("a delayed first cadence job preserves edits made after baseline capture", async () => {
  const f = await fixture();
  const edited = {
    ...f.probe,
    version: 2,
    intervalSeconds: 600,
    updatedAt: at(10),
  };
  assert.deepEqual(
    planWatchCadence(f.watch, f.captured, edited, undefined, at(10)),
    { state: "skip", decision: "superseded" },
  );
});
