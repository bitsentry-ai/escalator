import type { PagingTransaction } from "../src/application/paging/persistence.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
import { openPageInTransaction } from "../src/application/paging/create-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  deploymentWatchRecordSchema,
  type DeploymentOutcome,
  type WatchEvidenceWindow,
} from "../src/contracts/index.js";
import {
  startDeploymentWatch,
  advanceDeploymentWatch,
  linkWatchIncident,
} from "../src/application/deploy/watch-record.js";
import {
  evaluateWatchProjection,
  watchEvidenceContext,
} from "../src/application/deploy/watch-reader.js";
import {
  baselineFromProjection,
  type BaselineProjection,
} from "../src/application/deploy/baseline-reader.js";
import { watchPagePolicy } from "../src/application/deploy/watch-page-policy.js";
import {
  evaluateWatchStream,
  probeWatchCriteria,
} from "../src/application/deploy/watch.js";
import {
  finishDeployment,
  timeoutDeployment,
} from "../src/domain/deploy/lifecycle.js";
import { MemoryDeploymentRepository } from "./conformance/memory-deployments.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";
const scope = workspaceIdSchema.parse("watch-record");
const at = (s: number) =>
  new Date(Date.parse("2026-10-04T00:00:00.000Z") + s * 1000).toISOString();
async function entry(outcome: DeploymentOutcome = "SUCCEEDED", late = false) {
  const repository = new MemoryDeploymentRepository();
  await seedDeploymentFixture(
    {
      repository,
      configuration: repository.configuration,
      work: repository.work,
      dispose: async () => {},
    },
    scope,
  );
  const value = await repository.transaction(scope, (tx) =>
    fixtureDeployment(tx),
  );
  if (late) {
    const expired = timeoutDeployment(value.deployment, at(900));
    assert.equal(expired.state, "changed");
    if (expired.state !== "changed")
      throw new Error("expected a changed result");
    value.deployment = expired.deployment;
  }
  const transition = finishDeployment(
    value.deployment,
    {
      version: 1,
      source: value.deployment.source,
      externalId: value.deployment.externalId,
      environmentId: value.deployment.environmentId,
      actor: "deployer",
      occurredAt: at(late ? 1000 : 300),
      outcome,
    },
    at(late ? 1100 : 300),
  );
  assert.equal(transition.state, "changed");
  if (transition.state !== "changed")
    throw new Error("expected a changed result");
  return { ...value, deployment: transition.deployment };
}
function window(
  from: number,
  to: number,
  visible: number,
): WatchEvidenceWindow {
  return {
    workspaceId: scope,
    streamId: "probe",
    startAt: at(from),
    endAt: at(to),
    visibleAt: at(visible),
    complete: true,
    configurationCompatible: true,
    segments: [
      {
        version: 1,
        startAt: at(from),
        endAt: at(to),
        recordedAt: at(-1000),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: Array.from({ length: (to - from) / 60 }, (_, index) => {
      const point = from + index * 60;
      return {
        id: `receipt-${point}`,
        version: 1,
        slotAt: at(point),
        observedAt: at(point + 1),
        receivedAt: at(point + 2),
        usable: true,
        reading: { kind: "probe" as const, state: "healthy" as const },
      };
    }),
  };
}
function update(seconds = 2220, failed = false, threshold = 1) {
  const watch = window(300, Math.min(seconds, 2100), Math.min(seconds, 2220));
  if (failed) watch.samples[0].reading = { kind: "probe", state: "failed" };
  return {
    evaluatedAt: at(seconds),
    inventoryComplete: true,
    overlappingDeploymentIds: [],
    overlapInventoryComplete: true,
    streams: [
      {
        kind: "probe" as const,
        id: "probe",
        sourceId: "source",
        evaluation: evaluateWatchStream(scope, {
          deploymentStartedAt: at(0),
          watchEndsAt: at(2100),
          evaluatedAt: at(seconds),
          criteria: probeWatchCriteria({
            critical: threshold === 1,
            failureThreshold: threshold,
          }),
          baseline: window(-900, 0, 0),
          watch,
        }),
      },
    ],
  };
}
test("every recorded completion opens a server-time watch, including a late finish", async () => {
  for (const outcome of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    const value = startDeploymentWatch(await entry(outcome));
    assert.equal(value.startedAt, at(300));
    assert.equal(value.endsAt, at(2100));
    assert.equal(value.verdict, "PENDING");
  }
  const late = startDeploymentWatch(await entry("FAILED", true));
  assert.equal(late.startedAt, at(1100));
  assert.equal(late.endsAt, at(2900));
  const incomplete = await entry();
  incomplete.deployment.finish = null;
  assert.throws(() => startDeploymentWatch(incomplete));
});
test("healthy partial evidence stays pending until the full watch and grace", async () => {
  const initial = startDeploymentWatch(await entry());
  const pending = advanceDeploymentWatch(initial, update(360));
  assert.equal(pending.verdict, "PENDING");
  assert.equal(pending.finalizedAt, null);
  const final = advanceDeploymentWatch(pending, update());
  assert.equal(final.verdict, "PASS");
  assert.equal(final.finalizedAt, at(2220));
  assert.equal(final.revision, 3);
});
test("missing inventory and empty evidence cannot produce a healthy verdict", async () => {
  const value = startDeploymentWatch(await entry());
  assert.equal(
    advanceDeploymentWatch(value, { ...update(), inventoryComplete: false })
      .verdict,
    "INSUFFICIENT_DATA",
  );
  assert.equal(
    advanceDeploymentWatch(value, { ...update(), streams: [] }).verdict,
    "INSUFFICIENT_DATA",
  );
});
test("first failure and its incident survive a later healthy evaluation", async () => {
  const value = startDeploymentWatch(await entry());
  const failed = linkWatchIncident(
    advanceDeploymentWatch(value, update(360, true)),
    "related-incident",
  );
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.finalizedAt, null);
  const final = advanceDeploymentWatch(failed, update());
  assert.equal(final.verdict, "FAIL");
  assert.equal(final.incidentId, "related-incident");
  assert.deepEqual(final.firstFailure, failed.firstFailure);
  assert.equal(final.streams[0].evaluation.verdict, "PASS");
  assert.throws(() => linkWatchIncident(final, "different-incident"));
  assert.deepEqual(linkWatchIncident(final, "related-incident"), final);
});
test("known failure remains actionable even with incomplete other inventory", async () => {
  const value = advanceDeploymentWatch(startDeploymentWatch(await entry()), {
    ...update(360, true),
    inventoryComplete: false,
  });
  assert.equal(value.verdict, "FAIL");
});
test("an isolated failure below the captured threshold remains a final warning", async () => {
  const value = advanceDeploymentWatch(
    startDeploymentWatch(await entry()),
    update(2220, true, 3),
  );
  assert.equal(value.verdict, "WARN");
  assert.equal(value.firstFailure, null);
  assert.throws(() => linkWatchIncident(value, "incident"));
});
test("final decisions cannot be overwritten by later receipts", async () => {
  const value = advanceDeploymentWatch(
    startDeploymentWatch(await entry()),
    update(),
  );
  assert.deepEqual(advanceDeploymentWatch(value, update(2280, true)), value);
  assert.throws(() => advanceDeploymentWatch(value, update(360)), /backwards/);
});
test("mixed cutoffs and duplicate stream bindings are rejected", async () => {
  const value = startDeploymentWatch(await entry());
  const mixed = update();
  mixed.evaluatedAt = at(2280);
  assert.throws(() => advanceDeploymentWatch(value, mixed), /cutoff/);
  const duplicate = update();
  duplicate.streams.push(structuredClone(duplicate.streams[0]));
  assert.throws(() => advanceDeploymentWatch(value, duplicate));
});
test("overlap inventory is historical, bounded and honest about overflow", async () => {
  const value = startDeploymentWatch(await entry());
  const first = advanceDeploymentWatch(value, {
    ...update(360),
    overlappingDeploymentIds: Array.from({ length: 128 }, (_, i) => `a-${i}`),
  });
  const final = advanceDeploymentWatch(first, {
    ...update(),
    overlappingDeploymentIds: Array.from({ length: 128 }, (_, i) => `b-${i}`),
  });
  assert.equal(final.overlappingDeploymentIds.length, 128);
  assert.equal(final.overlapInventoryComplete, false);
  assert.throws(
    () =>
      advanceDeploymentWatch(value, {
        ...update(),
        overlappingDeploymentIds: [value.deploymentId],
      }),
    /itself/,
  );
});
test("results are copied and revision exhaustion cannot silently wrap", async () => {
  const value = startDeploymentWatch(await entry()),
    input = update();
  const result = advanceDeploymentWatch(value, input);
  input.streams[0].evaluation.reason = "observing";
  assert.equal(result.streams[0].evaluation.reason, "stable");
  assert.equal(value.evaluatedAt, null);
  assert.throws(() =>
    advanceDeploymentWatch(
      { ...value, revision: Number.MAX_SAFE_INTEGER },
      update(),
    ),
  );
  assert.equal(
    deploymentWatchRecordSchema.safeParse({ ...value, verdict: "PASS" })
      .success,
    false,
  );
});

async function readerFixture() {
  const value = await entry(),
    watch = startDeploymentWatch(value),
    owner = value.deployment;
  const base: BaselineProjection = {
    workspaceId: scope,
    serviceId: owner.serviceId,
    environmentId: owner.environmentId,
    capturedAt: at(0),
    inventoryComplete: true,
    streams: [
      {
        workspaceId: scope,
        serviceId: owner.serviceId,
        environmentId: owner.environmentId,
        kind: "probe",
        id: "probe",
        sourceId: "source",
        configurationVersion: 1,
        measurementHash: "a".repeat(64),
        complete: true,
        critical: true,
        failureThreshold: 1,
        configurations: [
          {
            version: 1,
            effectiveAt: at(-1000),
            recordedAt: at(-1000),
            enabled: true,
            anchorAt: at(0),
            stepSeconds: 60,
            measurementHash: "a".repeat(64),
          },
        ],
        receipts: window(-900, 0, 0).samples,
      },
    ],
  };
  const baseline = baselineFromProjection(value, base);
  const projection = structuredClone(base);
  projection.capturedAt = at(2220);
  projection.streams[0].receipts = window(300, 2100, 2220).samples;
  return { value, watch, baseline, projection };
}
test("captured criteria and historical measurements survive a post-window change", async () => {
  const f = await readerFixture(),
    stream = f.projection.streams[0];
  stream.configurationVersion = 2;
  stream.measurementHash = "b".repeat(64);
  stream.configurations.push({
    ...stream.configurations[0],
    version: 2,
    effectiveAt: at(2160),
    recordedAt: at(2160),
    enabled: false,
    measurementHash: "b".repeat(64),
  });
  const result = evaluateWatchProjection(
    f.value,
    f.watch,
    f.baseline,
    f.projection,
  );
  assert.equal(result.streams[0].evaluation.verdict, "PASS");
  assert.deepEqual(
    result.streams[0].evaluation.criteria,
    f.baseline.streams[0].criteria,
  );
});
test("an incompatible in-window measurement change is insufficient evidence", async () => {
  const f = await readerFixture(),
    stream = f.projection.streams[0];
  stream.configurationVersion = 2;
  stream.configurations.push({
    ...stream.configurations[0],
    version: 2,
    effectiveAt: at(1200),
    recordedAt: at(1200),
    measurementHash: "b".repeat(64),
  });
  const result = evaluateWatchProjection(
    f.value,
    f.watch,
    f.baseline,
    f.projection,
  );
  assert.equal(result.streams[0].evaluation.verdict, "INSUFFICIENT_DATA");
});
test("late unusable receipts do not replace evidence known at the grace cutoff", async () => {
  const f = await readerFixture(),
    stream = f.projection.streams[0];
  stream.receipts.push({
    ...stream.receipts[0],
    id: "late-correction",
    receivedAt: at(2300),
    usable: false,
  });
  f.projection.capturedAt = at(2400);
  const result = evaluateWatchProjection(
    f.value,
    f.watch,
    f.baseline,
    f.projection,
  );
  assert.equal(result.streams[0].evaluation.verdict, "PASS");
  assert.equal(
    result.streams[0].evaluation.watch.evidence.some(
      (row) => row.id === "late-correction",
    ),
    false,
  );
});
test("missing captured streams and missing baselines remain explicit", async () => {
  const f = await readerFixture();
  f.projection.streams = [];
  const missing = evaluateWatchProjection(
    f.value,
    f.watch,
    f.baseline,
    f.projection,
  );
  assert.equal(missing.inventoryComplete, false);
  assert.equal(missing.streams[0].evaluation.verdict, "INSUFFICIENT_DATA");
  const absent = evaluateWatchProjection(
    f.value,
    f.watch,
    undefined,
    f.projection,
  );
  assert.equal(absent.inventoryComplete, false);
  assert.deepEqual(absent.streams, []);
});
test("foreign scope and replacement source identities are rejected before evaluation", async () => {
  const f = await readerFixture();
  assert.throws(() =>
    watchEvidenceContext(
      workspaceIdSchema.parse("other"),
      f.value,
      f.watch,
      f.baseline,
    ),
  );
  f.projection.streams[0].sourceId = "different-source";
  assert.throws(() =>
    evaluateWatchProjection(f.value, f.watch, f.baseline, f.projection),
  );
});
test("watch paging preserves the configured schedule ladder and accepted deployment provenance", async () => {
  const f = await readerFixture(),
    failed = advanceDeploymentWatch(f.watch, update(360, true)),
    policy = watchPagePolicy(f.value, failed);
  assert.throws(() => watchPagePolicy(f.value, f.watch), /failed watch/);
  assert.deepEqual(policy.steps, f.value.policy.steps);
  assert.deepEqual(
    policy.fallbackResponderIds,
    f.value.policy.fallbackResponderIds,
  );
  assert.deepEqual(policy.watch, {
    targetId: f.value.targetId,
    deploymentId: f.value.deployment.id,
  });
  assert.throws(() =>
    watchPagePolicy(f.value, { ...failed, deploymentId: "foreign" }),
  );
});

test("disabling intake blocks new manual pages but preserves an accepted failed watch", async () => {
  const f = await readerFixture();
  const failed = advanceDeploymentWatch(f.watch, update(360, true));
  const repository = new MemoryPagingRepository({
    now: () => new Date(at(360)),
  });
  await repository.transaction(scope, seedPagingFixture);
  const incident = {
    id: "watch-incident",
    serviceId: f.value.deployment.serviceId,
    environmentId: f.value.deployment.environmentId,
    title: "Deployment watch failed",
    severity: "critical" as const,
  };
  const disabled = (tx: PagingTransaction) => ({
    ...tx,
    services: {
      ...tx.services,
      get: async (id: Parameters<PagingTransaction["services"]["get"]>[0]) => {
        const service = await tx.services.get(id);
        return service ? { ...service, enabled: false } : undefined;
      },
    },
  });
  await assert.rejects(
    repository.transaction(scope, (tx) =>
      openPageInTransaction(disabled(tx), { incident, policy: f.value.policy }),
    ),
    /Service is unavailable/,
  );
  const page = await repository.transaction(scope, (tx) =>
    openPageInTransaction(disabled(tx), {
      incident,
      policy: watchPagePolicy(f.value, failed),
    }),
  );
  assert.equal(page.incidentId, incident.id);
  assert.equal("watch" in page.policy, true);
});
