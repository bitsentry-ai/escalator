import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceIdSchema,
  type DeploymentEntry,
  type WatchEvidenceWindow,
} from "../src/contracts/index.js";
import { finishDeployment } from "../src/domain/deploy/lifecycle.js";
import { baselineFromProjection } from "../src/application/deploy/baseline-reader.js";
import { evaluateWatchStream } from "../src/application/deploy/watch.js";
import type { WatchEvaluationUpdate } from "../src/application/deploy/watch-record.js";
import type { DeploymentWatchTransaction } from "../src/application/deploy/watch-persistence.js";
import { openPageInTransaction } from "../src/application/paging/create-page.js";
import { MemoryDeploymentWatchRepository } from "./conformance/memory-deployment-watches.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";
const scope = workspaceIdSchema.parse("watch-persistence");
const at = (s: number) =>
  new Date(Date.parse("2026-10-04T00:00:00.000Z") + s * 1000).toISOString();
function captured(entry: DeploymentEntry) {
  return baselineFromProjection(entry, {
    workspaceId: scope,
    serviceId: entry.deployment.serviceId,
    environmentId: entry.deployment.environmentId,
    capturedAt: at(0),
    inventoryComplete: true,
    streams: [
      {
        workspaceId: scope,
        serviceId: entry.deployment.serviceId,
        environmentId: entry.deployment.environmentId,
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
            effectiveAt: at(-3600),
            recordedAt: at(-3600),
            enabled: true,
            anchorAt: at(0),
            stepSeconds: 60,
            measurementHash: "a".repeat(64),
          },
        ],
        receipts: Array.from({ length: 15 }, (_, i) => ({
          id: `baseline-${i}`,
          version: 1,
          slotAt: at(-900 + i * 60),
          observedAt: at(-899 + i * 60),
          receivedAt: at(-898 + i * 60),
          usable: true,
          reading: { kind: "probe" as const, state: "healthy" as const },
        })),
      },
    ],
  });
}
async function fixture(withEvidence = false) {
  let seconds = 0;
  const repository = new MemoryDeploymentWatchRepository({
    now: () => new Date(at(seconds)),
  });
  if (withEvidence) repository.captureBaseline = captured;
  await seedDeploymentFixture(
    {
      repository,
      configuration: repository.configuration,
      work: repository.work,
      dispose: async () => {},
    },
    scope,
  );
  const entry = await repository.transaction(scope, async (tx) => {
    const value = await fixtureDeployment(tx);
    await tx.deployments.insert(value);
    return value;
  });
  const finish = () =>
    repository.transaction(scope, async (tx) => {
      const change = finishDeployment(
        entry.deployment,
        {
          version: 1,
          source: entry.deployment.source,
          externalId: entry.deployment.externalId,
          environmentId: entry.deployment.environmentId,
          actor: "ci",
          occurredAt: at(seconds),
          outcome: "SUCCEEDED",
        },
        at(seconds),
      );
      assert.equal(change.state, "changed");
      if (change.state !== "changed") throw new Error();
      assert.equal(
        await tx.deployments.replace(entry.targetId, change.deployment, 1),
        true,
      );
    });
  return {
    repository,
    entry,
    finish,
    setTime: (value: number) => {
      seconds = value;
    },
    initialize: () =>
      repository.transaction(scope, (tx) =>
        tx.watches.initialize(entry.targetId, entry.deployment.id),
      ),
    get: () =>
      repository.transaction(scope, (tx) =>
        tx.watches.get(entry.targetId, entry.deployment.id),
      ),
  };
}
const emptyUpdate = (seconds: number): WatchEvaluationUpdate => ({
  evaluatedAt: at(seconds),
  streams: [],
  inventoryComplete: false,
  overlappingDeploymentIds: [],
  overlapInventoryComplete: true,
});
function failedUpdate(entry: DeploymentEntry): WatchEvaluationUpdate {
  const baseline = captured(entry).streams[0];
  const watch: WatchEvidenceWindow = {
    workspaceId: scope,
    streamId: "probe",
    startAt: at(0),
    endAt: at(60),
    visibleAt: at(60),
    complete: true,
    configurationCompatible: true,
    segments: [
      {
        version: 1,
        startAt: at(0),
        endAt: at(60),
        recordedAt: at(-3600),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: [
      {
        id: "failed-probe",
        version: 1,
        slotAt: at(0),
        observedAt: at(1),
        receivedAt: at(2),
        usable: true,
        reading: { kind: "probe", state: "failed" },
      },
    ],
  };
  return {
    ...emptyUpdate(60),
    inventoryComplete: true,
    streams: [
      {
        kind: "probe",
        id: "probe",
        sourceId: "source",
        evaluation: evaluateWatchStream(scope, {
          baseline: baseline.evidence,
          watch,
          criteria: baseline.criteria,
          evaluatedAt: at(60),
          deploymentStartedAt: at(0),
          watchEndsAt: at(1800),
        }),
      },
    ],
  };
}
test("watch initialization requires a recorded finish and is idempotent", async () => {
  const f = await fixture();
  await assert.rejects(f.initialize(), /finish/);
  await f.finish();
  const first = await f.initialize();
  assert.equal(first.verdict, "PENDING");
  assert.equal(first.revision, 1);
  assert.deepEqual(await f.initialize(), first);
});
test("watch reads do not expose foreign deployments and handles expire", async () => {
  const f = await fixture();
  await f.finish();
  await f.initialize();
  await assert.rejects(
    f.repository.transaction(workspaceIdSchema.parse("foreign"), (tx) =>
      tx.watches.get(f.entry.targetId, f.entry.deployment.id),
    ),
    /not_found/,
  );
  let handle: DeploymentWatchTransaction | undefined;
  await f.repository.transaction(scope, async (tx) => {
    handle = tx;
  });
  await assert.rejects(
    handle!.watches.get(f.entry.targetId, f.entry.deployment.id),
    /closed_transaction/,
  );
});
test("caught watch insertion failure rolls back the lifecycle completion", async () => {
  const f = await fixture();
  f.repository.failWatchInsert = true;
  await assert.rejects(
    f.repository.transaction(scope, async (tx) => {
      const change = finishDeployment(
        f.entry.deployment,
        {
          version: 1,
          source: f.entry.deployment.source,
          externalId: f.entry.deployment.externalId,
          environmentId: f.entry.deployment.environmentId,
          actor: "ci",
          occurredAt: at(0),
          outcome: "SUCCEEDED",
        },
        at(0),
      );
      if (change.state !== "changed") throw new Error();
      await tx.deployments.replace(f.entry.targetId, change.deployment, 1);
      await assert.rejects(
        tx.watches.initialize(f.entry.targetId, f.entry.deployment.id),
        /Injected/,
      );
    }),
    /Injected/,
  );
  const saved = await f.repository.transaction(scope, (tx) =>
    tx.deployments.get(f.entry.targetId, f.entry.deployment.id),
  );
  assert.equal(saved?.deployment.status, "STARTED");
  assert.equal(await f.get(), undefined);
});
test("watch CAS refuses stale revisions without overwriting the current verdict", async () => {
  const f = await fixture();
  await f.finish();
  await f.initialize();
  f.setTime(60);
  const first = await f.repository.transaction(scope, (tx) =>
    tx.watches.advance(
      f.entry.targetId,
      f.entry.deployment.id,
      1,
      emptyUpdate(60),
    ),
  );
  assert.equal(first?.verdict, "INSUFFICIENT_DATA");
  assert.equal(first?.revision, 2);
  const stale = await f.repository.transaction(scope, (tx) =>
    tx.watches.advance(
      f.entry.targetId,
      f.entry.deployment.id,
      1,
      emptyUpdate(60),
    ),
  );
  assert.equal(stale, undefined);
  assert.deepEqual(await f.get(), first);
});
test("future or backdated evaluation times cannot commit", async () => {
  const f = await fixture();
  await f.finish();
  await f.initialize();
  f.setTime(60);
  for (const seconds of [59, 61])
    await assert.rejects(
      f.repository.transaction(scope, (tx) =>
        tx.watches.advance(
          f.entry.targetId,
          f.entry.deployment.id,
          1,
          emptyUpdate(seconds),
        ),
      ),
      /transaction's clock/,
    );
  assert.equal((await f.get())?.revision, 1);
});
test("an empty captured inventory cannot become healthy and final verdicts are immutable", async () => {
  const f = await fixture();
  await f.finish();
  await f.initialize();
  f.setTime(1920);
  const final = await f.repository.transaction(scope, (tx) =>
    tx.watches.advance(
      f.entry.targetId,
      f.entry.deployment.id,
      1,
      emptyUpdate(1920),
    ),
  );
  assert.equal(final?.verdict, "INSUFFICIENT_DATA");
  assert.equal(final?.finalizedAt, at(1920));
  f.setTime(1980);
  const later = await f.repository.transaction(scope, (tx) =>
    tx.watches.advance(
      f.entry.targetId,
      f.entry.deployment.id,
      2,
      emptyUpdate(1980),
    ),
  );
  assert.deepEqual(later, final);
});
test("a failed watch cannot commit without its incident even when the error is caught", async () => {
  const f = await fixture(true);
  await f.finish();
  await f.initialize();
  f.setTime(60);
  assert.equal(failedUpdate(f.entry).streams[0].evaluation.verdict, "FAIL");
  await assert.rejects(
    f.repository.transaction(scope, async (tx) => {
      await assert.rejects(
        tx.watches.advance(
          f.entry.targetId,
          f.entry.deployment.id,
          1,
          failedUpdate(f.entry),
        ),
        /atomic incident/,
      );
    }),
    /atomic incident/,
  );
  assert.equal((await f.get())?.revision, 1);
});
test("a failed watch and its page commit together and keep the first link", async () => {
  const f = await fixture(true);
  await f.finish();
  await f.initialize();
  f.setTime(60);
  const saved = await f.repository.transaction(scope, async (tx) => {
    await openPageInTransaction(tx, {
      incident: {
        id: "watch-linked-incident",
        serviceId: f.entry.deployment.serviceId,
        environmentId: f.entry.deployment.environmentId,
        title: "Watch failure",
        severity: "critical",
      },
      policy: f.entry.policy,
    });
    return tx.watches.advance(
      f.entry.targetId,
      f.entry.deployment.id,
      1,
      failedUpdate(f.entry),
      "watch-linked-incident",
    );
  });
  assert.equal(saved?.verdict, "FAIL");
  assert.equal(saved?.incidentId, "watch-linked-incident");
  await assert.rejects(
    f.repository.transaction(scope, (tx) =>
      tx.watches.advance(
        f.entry.targetId,
        f.entry.deployment.id,
        2,
        failedUpdate(f.entry),
        "other",
      ),
    ),
    /immutable/,
  );
  assert.deepEqual(await f.get(), saved);
});
test("missing incident rolls back a failed-watch write", async () => {
  const f = await fixture(true);
  await f.finish();
  await f.initialize();
  f.setTime(60);
  await assert.rejects(
    f.repository.transaction(scope, (tx) =>
      tx.watches.advance(
        f.entry.targetId,
        f.entry.deployment.id,
        1,
        failedUpdate(f.entry),
        "missing",
      ),
    ),
    /scope_violation/,
  );
  assert.equal((await f.get())?.revision, 1);
});
test("replacement sources and altered criteria cannot create a verdict", async () => {
  const f = await fixture(true);
  await f.finish();
  await f.initialize();
  f.setTime(60);
  const changed = failedUpdate(f.entry);
  changed.streams[0].sourceId = "replacement";
  await assert.rejects(
    f.repository.transaction(scope, (tx) =>
      tx.watches.advance(
        f.entry.targetId,
        f.entry.deployment.id,
        1,
        changed,
        "incident",
      ),
    ),
    /scope_violation/,
  );
  const changedCriteria = failedUpdate(f.entry);
  changedCriteria.streams[0].evaluation.criteria = {
    version: 1,
    kind: "probe",
    failureThreshold: 2,
    baselineMinimumSamples: 3,
  };
  await assert.rejects(
    f.repository.transaction(scope, (tx) =>
      tx.watches.advance(
        f.entry.targetId,
        f.entry.deployment.id,
        1,
        changedCriteria,
        "incident",
      ),
    ),
    /scope_violation/,
  );
  assert.equal((await f.get())?.revision, 1);
});
test("a failed watch validation rolls back a page inserted in the same transaction", async () => {
  const f = await fixture(true);
  await f.finish();
  await f.initialize();
  f.setTime(60);
  await assert.rejects(
    f.repository.transaction(scope, async (tx) => {
      await openPageInTransaction(tx, {
        incident: {
          id: "rolled-back",
          serviceId: f.entry.deployment.serviceId,
          environmentId: f.entry.deployment.environmentId,
          title: "Watch failure",
          severity: "critical",
        },
        policy: f.entry.policy,
      });
      await assert.rejects(
        tx.watches.advance(
          f.entry.targetId,
          f.entry.deployment.id,
          1,
          failedUpdate(f.entry),
          "missing",
        ),
        /scope_violation/,
      );
    }),
    /scope_violation/,
  );
  assert.equal(
    await f.repository.transaction(scope, (tx) =>
      tx.incidents.get("rolled-back"),
    ),
    undefined,
  );
  assert.equal((await f.get())?.revision, 1);
});
