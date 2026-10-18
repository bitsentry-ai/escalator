import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, scope, at } from "./conformance/watch-cadence-fixture.js";
import { WatchCadenceCoordinator } from "../src/application/deploy/cadence-coordinator.js";
import {
  WatchProbeCadenceJobs,
  withWatchCadenceHandlers,
} from "../src/application/deploy/cadence-jobs.js";
import { defaultProbeLimits } from "../src/application/probes/capacity.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import { scheduleProbe } from "../src/application/probes/execute.js";
import { fixtureDeployment } from "./conformance/deployments.js";
import { finishDeployment } from "../src/domain/deploy/lifecycle.js";
import type { DeploymentWatchRecord } from "../src/contracts/index.js";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const jobs = (f: Fixture) =>
  new WatchProbeCadenceJobs(f.repo, { ...defaultProbeLimits });
async function claim(f: Fixture, kind: string, leaseMs = 60000) {
  const value = await f.repo.work.claim({
    workspaceId: scope,
    queue: "job",
    kinds: [kind],
    token: randomUUID(),
    leaseMs,
  });
  assert.ok(value);
  return value;
}
async function queue(f: Fixture, value?: DeploymentWatchRecord) {
  const watch =
    value ??
    (await f.repo.transaction(scope, (tx) =>
      tx.watches.get(f.entry.targetId, f.entry.deployment.id),
    ))!;
  await f.repo.transaction(scope, async (tx) => {
    const id = pagingWorkId(
      scope,
      "deployment.watch-cadence",
      watch.targetId,
      watch.deploymentId,
    );
    await tx.work.enqueue("job", {
      id,
      kind: "deployment.watch-cadence",
      idempotencyKey: id,
      dueAt: watch.startedAt,
      priority: 80,
      payload: {
        targetId: watch.targetId,
        deploymentId: watch.deploymentId,
        startedAt: watch.startedAt,
      },
    });
  });
}
async function ready(f: Fixture) {
  await queue(f);
  const lease = await claim(f, "deployment.watch-cadence");
  const coordinator = new WatchCadenceCoordinator(f.repo);
  const result = await coordinator.run(lease);
  await coordinator.run(lease);
  assert.ok(await f.repo.work.settle(lease, result));
  return claim(f, "deployment.watch-probe-cadence");
}
const probe = (f: Fixture) =>
  f.repo.transaction(scope, (tx) => tx.probeContext.probes.get("probe"));
const owner = (f: Fixture) =>
  f.repo.transaction(scope, (tx) =>
    tx.cadence.lease(f.entry.targetId, "probe"),
  );
async function edit(f: Fixture, intervalSeconds = 600) {
  await f.repo.transaction(scope, async (tx) => {
    const context = tx.probeContext;
    await context.probes.lockCapacity();
    const current = (await context.probes.lock("probe"))!,
      source = (await context.sources.get(current.sourceId))!;
    const next = {
      ...current,
      intervalSeconds,
      version: current.version + 1,
      updatedAt: tx.now,
    };
    assert.ok(await context.probes.put(next, current.version));
    assert.ok(
      await context.sources.replace(
        { ...source, version: source.version + 1, updatedAt: tx.now },
        source.version,
      ),
    );
    await scheduleProbe(context, next, tx.now);
  });
}
test("cadence jobs tighten once, restore once, and retain the immutable receipt", async () => {
  const f = await fixture(),
    lease = await ready(f);
  await jobs(f).tighten(lease);
  await jobs(f).tighten(lease);
  assert.equal((await probe(f))?.intervalSeconds, 60);
  assert.equal((await probe(f))?.version, 2);
  assert.ok(await owner(f));
  f.time(1800);
  const restore = await claim(f, "deployment.watch-cadence-restore");
  await jobs(f).restore(restore);
  await jobs(f).restore(restore);
  assert.equal((await probe(f))?.intervalSeconds, 300);
  assert.equal((await probe(f))?.version, 3);
  assert.equal(await owner(f), undefined);
  const receipt = await f.repo.transaction(scope, (tx) =>
    tx.cadence.receipt(f.entry.targetId, f.entry.deployment.id, "probe"),
  );
  assert.equal(receipt?.decision, "tightened");
  assert.equal(receipt?.appliedProbeVersion, 2);
});
test("late first cadence job preserves a manual edit made after capture", async () => {
  const f = await fixture(),
    lease = await ready(f);
  f.time(10);
  await edit(f);
  await jobs(f).tighten(lease);
  assert.equal((await probe(f))?.intervalSeconds, 600);
  assert.equal(await owner(f), undefined);
  const receipt = await f.repo.transaction(scope, (tx) =>
    tx.cadence.receipt(f.entry.targetId, f.entry.deployment.id, "probe"),
  );
  assert.equal(receipt?.decision, "superseded");
});
test("restoration and tightening replay preserve an operator's newer version", async () => {
  const f = await fixture(),
    lease = await ready(f);
  await jobs(f).tighten(lease);
  f.time(10);
  await edit(f);
  await jobs(f).tighten(lease);
  f.time(1800);
  await jobs(f).restore(await claim(f, "deployment.watch-cadence-restore"));
  assert.equal((await probe(f))?.intervalSeconds, 600);
  assert.equal((await probe(f))?.version, 3);
  assert.equal(await owner(f), undefined);
});
test("expired cadence claim cannot change probe configuration", async () => {
  const f = await fixture();
  await queue(f);
  const coordinator = await claim(f, "deployment.watch-cadence");
  await new WatchCadenceCoordinator(f.repo).run(coordinator);
  const lease = await claim(f, "deployment.watch-probe-cadence", 1000);
  f.time(2);
  assert.deepEqual(await jobs(f).tighten(lease), { state: "completed" });
  assert.equal((await probe(f))?.version, 1);
  assert.equal(await owner(f), undefined);
});
test("failed receipt rolls back probe, source, scheduling and restoration work", async () => {
  const f = await fixture(),
    lease = await ready(f);
  f.repo.failReceipt = true;
  await assert.rejects(jobs(f).tighten(lease), /Injected cadence receipt/);
  assert.equal((await probe(f))?.version, 1);
  assert.equal(await owner(f), undefined);
  await f.repo.transaction(scope, async (tx) => {
    assert.equal(
      (await tx.probeContext.sources.get("probe-source"))?.version,
      1,
    );
    assert.equal(await tx.probeContext.probes.schedule("probe"), undefined);
  });
  f.time(1800);
  assert.equal(
    await f.repo.work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["deployment.watch-cadence-restore"],
      token: randomUUID(),
      leaseMs: 60000,
    }),
    undefined,
  );
});
test("an overlapping watch extends the first restoration deadline", async () => {
  const f = await fixture(),
    first = await ready(f);
  assert.ok(await f.repo.work.settle(first, await jobs(f).tighten(first)));
  const original = (await owner(f))!;
  f.time(600);
  await edit(f, 60);
  const captured = f.repo.watches.captureBaseline!;
  const version = (await probe(f))!.version;
  f.repo.watches.captureBaseline = (entry) => {
    const snapshot = captured(entry);
    return {
      ...snapshot,
      streams: snapshot.streams.map((stream) => ({
        ...stream,
        configurationVersion: version,
      })),
    };
  };
  const second = await f.repo.transaction(scope, async (tx) => {
    const entry = await fixtureDeployment(tx, "second");
    await tx.deployments.insert(entry);
    const result = finishDeployment(
      entry.deployment,
      {
        version: 1,
        source: entry.deployment.source,
        externalId: "second",
        environmentId: entry.deployment.environmentId,
        actor: "ci",
        occurredAt: tx.now,
        outcome: "SUCCEEDED",
      },
      tx.now,
    );
    if (result.state !== "changed") throw new Error();
    await tx.deployments.replace(entry.targetId, result.deployment, 1);
    return tx.watches.initialize(entry.targetId, "second");
  });
  await queue(f, second);
  const batch = await claim(f, "deployment.watch-cadence");
  assert.ok(
    await f.repo.work.settle(
      batch,
      await new WatchCadenceCoordinator(f.repo).run(batch),
    ),
  );
  const nextProbe = await claim(f, "deployment.watch-probe-cadence");
  assert.ok(
    await f.repo.work.settle(nextProbe, await jobs(f).tighten(nextProbe)),
  );
  const renewed = (await owner(f))!;
  assert.equal(renewed.generationId, original.generationId);
  assert.equal(renewed.originalIntervalSeconds, 300);
  assert.equal(renewed.restoreAt, at(2400));
  assert.equal((await probe(f))?.version, 3);
  f.time(1800);
  const oldRestore = await claim(f, "deployment.watch-cadence-restore");
  assert.equal(oldRestore.payload.revision, 1);
  const stale = await jobs(f).restore(oldRestore);
  assert.deepEqual(stale, { state: "completed" });
  assert.ok(await f.repo.work.settle(oldRestore, stale));
  assert.equal((await probe(f))?.intervalSeconds, 60);
  f.time(2400);
  await jobs(f).restore(await claim(f, "deployment.watch-cadence-restore"));
  assert.equal((await probe(f))?.intervalSeconds, 300);
});
test("a later overlapping watch re-arms restoration after a terminal restore failure", async () => {
  const f = await fixture(),
    first = await ready(f);
  assert.ok(await f.repo.work.settle(first, await jobs(f).tighten(first)));
  f.time(1800);
  const failed = await claim(f, "deployment.watch-cadence-restore");
  assert.ok(await f.repo.work.settle(failed, { state: "failed" }));
  f.time(1900);
  const version = (await probe(f))!.version;
  const captured = f.repo.watches.captureBaseline!;
  f.repo.watches.captureBaseline = (entry) => {
    const snapshot = captured(entry);
    return {
      ...snapshot,
      streams: snapshot.streams.map((stream) => ({
        ...stream,
        configurationVersion: version,
      })),
    };
  };
  const later = await f.repo.transaction(scope, async (tx) => {
    const entry = await fixtureDeployment(tx, "later");
    await tx.deployments.insert(entry);
    const result = finishDeployment(
      entry.deployment,
      {
        version: 1,
        source: entry.deployment.source,
        externalId: "later",
        environmentId: entry.deployment.environmentId,
        actor: "ci",
        occurredAt: tx.now,
        outcome: "SUCCEEDED",
      },
      tx.now,
    );
    if (result.state !== "changed") throw new Error();
    await tx.deployments.replace(entry.targetId, result.deployment, 1);
    return tx.watches.initialize(entry.targetId, "later");
  });
  await queue(f, later);
  const batch = await claim(f, "deployment.watch-cadence");
  assert.ok(
    await f.repo.work.settle(
      batch,
      await new WatchCadenceCoordinator(f.repo).run(batch),
    ),
  );
  const join = await claim(f, "deployment.watch-probe-cadence");
  assert.ok(await f.repo.work.settle(join, await jobs(f).tighten(join)));
  assert.equal((await owner(f))?.revision, 2);
  f.time(3700);
  await jobs(f).restore(await claim(f, "deployment.watch-cadence-restore"));
  assert.equal((await probe(f))?.intervalSeconds, 300);
  assert.equal(await owner(f), undefined);
});
test("cadence handlers preserve existing lanes and reject duplicate registration", async () => {
  const f = await fixture(),
    handlers = { job: new Map(), outbox: new Map() };
  const next = withWatchCadenceHandlers(handlers, f.repo, {
    ...defaultProbeLimits,
  });
  assert.equal(next.job.size, 3);
  assert.equal(handlers.job.size, 0);
  assert.equal(next.outbox, handlers.outbox);
  assert.throws(
    () => withWatchCadenceHandlers(next, f.repo, { ...defaultProbeLimits }),
    /already registered/,
  );
});

async function extraProbe(f: Fixture, id: string) {
  await f.repo.transaction(scope, async (tx) => {
    const context = tx.probeContext;
    await context.probes.lockCapacity();
    const original = (await context.probes.get("probe"))!,
      source = (await context.sources.get(original.sourceId))!;
    const sourceId = `source-${id}`;
    await context.sources.insert({
      ...source,
      id: sourceId,
      version: 1,
      createdAt: tx.now,
      updatedAt: tx.now,
    });
    assert.ok(
      await context.probes.put(
        {
          ...original,
          id,
          sourceId,
          version: 1,
          createdAt: tx.now,
          updatedAt: tx.now,
        },
        null,
      ),
    );
  });
}
test("capacity rejection records a skipped application without changing the probe", async () => {
  const f = await fixture(),
    lease = await ready(f);
  await extraProbe(f, "load");
  const bounded = new WatchProbeCadenceJobs(f.repo, {
    maxActive: 1,
    maxConfigured: 1,
    concurrency: 1,
  });
  await bounded.tighten(lease);
  assert.equal((await probe(f))?.version, 1);
  assert.equal((await probe(f))?.intervalSeconds, 300);
  assert.equal(await owner(f), undefined);
  const receipt = await f.repo.transaction(scope, (tx) =>
    tx.cadence.receipt(f.entry.targetId, f.entry.deployment.id, "probe"),
  );
  assert.equal(receipt?.decision, "capacity_limited");
});
test("cadence coordinator fans out in replay-safe batches of at most eight", async () => {
  const f = await fixture();
  const ids = ["probe", ...Array.from({ length: 16 }, (_, i) => `probe-${i}`)];
  for (const id of ids.slice(1)) await extraProbe(f, id);
  const captured = f.repo.watches.captureBaseline!;
  f.repo.watches.captureBaseline = (entry) => {
    const snapshot = captured(entry),
      original = snapshot.streams[0];
    return {
      ...snapshot,
      streams: ids.map((id) => ({
        ...original,
        id,
        sourceId: id === "probe" ? "probe-source" : `source-${id}`,
        evidence: { ...original.evidence, streamId: id },
      })),
    };
  };
  const watch = await f.repo.transaction(scope, async (tx) => {
    const entry = await fixtureDeployment(tx, "batch");
    await tx.deployments.insert(entry);
    const change = finishDeployment(
      entry.deployment,
      {
        version: 1,
        source: entry.deployment.source,
        externalId: "batch",
        environmentId: entry.deployment.environmentId,
        actor: "ci",
        occurredAt: tx.now,
        outcome: "SUCCEEDED",
      },
      tx.now,
    );
    if (change.state !== "changed") throw new Error();
    await tx.deployments.replace(entry.targetId, change.deployment, 1);
    return tx.watches.initialize(entry.targetId, entry.deployment.id);
  });
  await queue(f, watch);
  const counts: number[] = [],
    seen = new Set<string>();
  for (const offset of [0, 8, 16]) {
    const batch = await claim(f, "deployment.watch-cadence");
    assert.equal(batch.payload.offset ?? 0, offset);
    const coordinator = new WatchCadenceCoordinator(f.repo);
    const result = await coordinator.run(batch);
    await coordinator.run(batch);
    assert.ok(await f.repo.work.settle(batch, result));
    let count = 0;
    for (;;) {
      const child = await f.repo.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["deployment.watch-probe-cadence"],
        token: randomUUID(),
        leaseMs: 60000,
      });
      if (!child) break;
      assert.equal(seen.has(String(child.payload.probeId)), false);
      seen.add(String(child.payload.probeId));
      count++;
    }
    counts.push(count);
  }
  assert.deepEqual(counts, [8, 8, 1]);
  assert.equal(seen.size, 17);
  assert.equal(
    await f.repo.work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["deployment.watch-cadence"],
      token: randomUUID(),
      leaseMs: 60000,
    }),
    undefined,
  );
});

test("overlap cannot extend faster cadence after configured capacity is reduced", async () => {
  const f = await fixture(),
    initial = await ready(f);
  assert.ok(await f.repo.work.settle(initial, await jobs(f).tighten(initial)));
  await extraProbe(f, "load");
  f.time(600);
  const captured = f.repo.watches.captureBaseline!;
  const version = (await probe(f))!.version;
  f.repo.watches.captureBaseline = (entry) => {
    const snapshot = captured(entry);
    return {
      ...snapshot,
      streams: snapshot.streams.map((stream) => ({
        ...stream,
        configurationVersion: version,
      })),
    };
  };
  const watch = await f.repo.transaction(scope, async (tx) => {
    const entry = await fixtureDeployment(tx, "limited");
    await tx.deployments.insert(entry);
    const result = finishDeployment(
      entry.deployment,
      {
        version: 1,
        source: entry.deployment.source,
        externalId: "limited",
        environmentId: entry.deployment.environmentId,
        actor: "ci",
        occurredAt: tx.now,
        outcome: "SUCCEEDED",
      },
      tx.now,
    );
    if (result.state !== "changed") throw new Error();
    await tx.deployments.replace(entry.targetId, result.deployment, 1);
    return tx.watches.initialize(entry.targetId, entry.deployment.id);
  });
  await queue(f, watch);
  const batch = await claim(f, "deployment.watch-cadence");
  assert.ok(
    await f.repo.work.settle(
      batch,
      await new WatchCadenceCoordinator(f.repo).run(batch),
    ),
  );
  const limited = new WatchProbeCadenceJobs(f.repo, {
    maxActive: 1,
    maxConfigured: 1,
    concurrency: 1,
  });
  await limited.tighten(await claim(f, "deployment.watch-probe-cadence"));
  assert.equal((await owner(f))?.restoreAt, at(1800));
  const receipt = await f.repo.transaction(scope, (tx) =>
    tx.cadence.receipt(watch.targetId, watch.deploymentId, "probe"),
  );
  assert.equal(receipt?.decision, "capacity_limited");
});

test("an unrelated probe edit during a watch still restores its original cadence", async () => {
  const f = await fixture();
  await jobs(f).tighten(await ready(f));
  f.time(10);
  await f.repo.transaction(scope, async (tx) => {
    const context = tx.probeContext;
    const current = (await context.probes.lock("probe"))!;
    const edited = {
      ...current,
      name: "Renamed during watch",
      version: current.version + 1,
      updatedAt: tx.now,
    };
    assert.ok(await context.probes.put(edited, current.version));
    await scheduleProbe(context, edited, tx.now);
  });
  f.time(1800);
  await jobs(f).restore(await claim(f, "deployment.watch-cadence-restore"));
  assert.equal((await probe(f))?.intervalSeconds, 300);
  assert.equal((await probe(f))?.name, "Renamed during watch");
  assert.equal(await owner(f), undefined);
});
