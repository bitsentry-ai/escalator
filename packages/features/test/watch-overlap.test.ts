import test from "node:test";
import assert from "node:assert/strict";
import { fixture, scope, at } from "./conformance/watch-cadence-fixture.js";
import {
  deploymentWatchOverlaps,
  deploymentWatchOverlapVisibleAt,
} from "../src/application/deploy/watch-overlap.js";
async function setup() {
  const f = await fixture(),
    watch = (await f.repo.transaction(scope, (tx) =>
      tx.watches.get(f.entry.targetId, f.entry.deployment.id),
    ))!;
  const projection = {
    workspaceId: scope,
    serviceId: watch.serviceId,
    environmentId: watch.environmentId,
    asOf: at(60),
    rows: [] as {
      id: string;
      startedAt: string;
      acceptedAt: string;
      finishedAt: string | null;
      timedOutAt: string | null;
    }[],
  };
  return { watch, projection };
}
test("overlap includes an earlier finished deployment while its watch still overlaps", async () => {
  const { watch, projection } = await setup();
  projection.rows = [
    {
      id: "earlier",
      startedAt: at(-1200),
      acceptedAt: at(-1200),
      finishedAt: at(-600),
      timedOutAt: null,
    },
  ];
  assert.deepEqual(deploymentWatchOverlaps(watch, projection), {
    overlappingDeploymentIds: ["earlier"],
    overlapInventoryComplete: true,
  });
  projection.rows[0].startedAt = at(-2000);
  projection.rows[0].acceptedAt = at(-2000);
  projection.rows[0].finishedAt = at(-1800);
  assert.throws(() => deploymentWatchOverlaps(watch, projection), /chronology/);
});
test("unfinished deployments remain uncertain and bounded overflow is explicit", async () => {
  const { watch, projection } = await setup();
  projection.rows = Array.from({ length: 129 }, (_, i) => ({
    id: `unknown-${i}`,
    startedAt: at(-86400),
    acceptedAt: at(-86400),
    finishedAt: null,
    timedOutAt: null,
  }));
  const result = deploymentWatchOverlaps(watch, projection);
  assert.equal(result.overlappingDeploymentIds.length, 128);
  assert.equal(result.overlapInventoryComplete, false);
});
test("a timeout without a finish bounds the overlap window", async () => {
  const { watch, projection } = await setup();
  projection.rows = [
    {
      id: "stuck",
      startedAt: at(-2400),
      acceptedAt: at(-2400),
      finishedAt: null,
      timedOutAt: at(-1200),
    },
  ];
  assert.deepEqual(deploymentWatchOverlaps(watch, projection), {
    overlappingDeploymentIds: ["stuck"],
    overlapInventoryComplete: true,
  });
  projection.rows[0].timedOutAt = at(-1800);
  assert.throws(() => deploymentWatchOverlaps(watch, projection), /chronology/);
  projection.rows[0].finishedAt = at(-600);
  assert.equal(
    deploymentWatchOverlaps(watch, projection).overlappingDeploymentIds.length,
    1,
  );
  projection.rows[0].finishedAt = null;
  projection.rows[0].timedOutAt = at(61);
  assert.throws(() => deploymentWatchOverlaps(watch, projection), /chronology/);
});
test("overlap cannot include receipts accepted after the evidence snapshot", async () => {
  const { watch, projection } = await setup();
  projection.rows = [
    {
      id: "late",
      startedAt: at(0),
      acceptedAt: at(61),
      finishedAt: null,
      timedOutAt: null,
    },
  ];
  assert.throws(() => deploymentWatchOverlaps(watch, projection), /chronology/);
  projection.rows[0].acceptedAt = at(0);
  projection.rows[0].finishedAt = at(61);
  assert.throws(() => deploymentWatchOverlaps(watch, projection), /chronology/);
});
test("overlap rejects cross-scope, duplicate and self identities", async () => {
  const { watch, projection } = await setup();
  assert.throws(
    () =>
      deploymentWatchOverlaps(watch, {
        ...projection,
        workspaceId: "elsewhere",
      }),
    /scope_violation/,
  );
  const row = {
    id: "other",
    startedAt: at(0),
    acceptedAt: at(0),
    finishedAt: null,
    timedOutAt: null,
  };
  assert.throws(
    () => deploymentWatchOverlaps(watch, { ...projection, rows: [row, row] }),
    /identity/,
  );
  assert.throws(
    () =>
      deploymentWatchOverlaps(watch, {
        ...projection,
        rows: [{ ...row, id: watch.deploymentId }],
      }),
    /identity/,
  );
});

test("delayed watch workers keep the original receipt visibility cutoff", async () => {
  const { watch, projection } = await setup();
  assert.equal(deploymentWatchOverlapVisibleAt(watch, at(86400)), at(1920));
  assert.throws(
    () => deploymentWatchOverlaps(watch, { ...projection, asOf: at(1921) }),
    /receipt cutoff/,
  );
});
