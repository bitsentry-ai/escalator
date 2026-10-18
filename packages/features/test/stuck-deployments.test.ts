import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  StuckDeployments,
  withDeploymentTimeout,
  withDeploymentTimeoutHandlers,
  type StuckDeploymentRepository,
} from "../src/application/deploy/stuck.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import { finishDeployment } from "../src/domain/deploy/lifecycle.js";
import { MemoryDeploymentRepository } from "./conformance/memory-deployments.js";
import {
  fixtureDeployment,
  seedDeploymentFixture,
} from "./conformance/deployments.js";

async function fixture() {
  const initial = Date.parse("2026-10-04T00:00:00.000Z");
  let seconds = 0;
  const scope = workspaceIdSchema.parse("stuck-jobs");
  const storage = new MemoryDeploymentRepository({
    now: () => new Date(initial + seconds * 1000),
  });
  await seedDeploymentFixture(
    {
      repository: storage,
      configuration: storage.configuration,
      work: storage.work,
      dispose: async () => {},
    },
    scope,
  );
  const repository: StuckDeploymentRepository = {
    transaction: (workspace, run) =>
      storage.withExtensions(workspace, (deployment, configuration) =>
        run(withDeploymentTimeout({ ...configuration, ...deployment })),
      ),
  };
  const start = (id = "deploy") =>
    repository.transaction(scope, async (tx) => {
      const entry = await fixtureDeployment(tx, id);
      await tx.deployments.insert(entry);
      return entry;
    });
  const claim = async () => {
    const value = await storage.work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["deployment.timeout"],
      token: randomUUID(),
      leaseMs: 10000,
    });
    assert.ok(value);
    return value;
  };
  const get = (id = "deploy") =>
    repository.transaction(scope, (tx) => tx.deployments.get("target", id));
  const pages = () =>
    repository.transaction(scope, (tx) => tx.pages.list({ limit: 100 }));
  const finish = () =>
    repository.transaction(scope, async (tx) => {
      await tx.targets.get("target");
      const current = (await tx.deployments.get("target", "deploy"))!
        .deployment;
      const value = finishDeployment(
        current,
        {
          version: 1,
          source: current.source,
          externalId: current.externalId,
          environmentId: current.environmentId,
          actor: "ci",
          occurredAt: tx.now,
          outcome: "SUCCEEDED",
        },
        tx.now,
      );
      if (value.state !== "changed") throw new Error("Expected finish");
      assert.equal(
        await tx.deployments.replace(
          "target",
          value.deployment,
          current.revision,
        ),
        true,
      );
    });
  return {
    scope,
    storage,
    repository,
    start,
    claim,
    get,
    pages,
    finish,
    jobs: new StuckDeployments(repository),
    time: (value: number) => {
      seconds = value;
    },
  };
}
test("start records one deadline and timeout opens one atomic page across concurrent retries", async () => {
  const f = await fixture();
  const entry = await f.start();
  assert.equal(
    await f.storage.work.claim({
      workspaceId: f.scope,
      queue: "job",
      kinds: ["deployment.timeout"],
      token: randomUUID(),
      leaseMs: 10000,
    }),
    undefined,
  );
  f.time(600);
  const lease = await f.claim();
  assert.equal(lease.dueAt, entry.deployment.timeoutAt);
  assert.deepEqual(await Promise.all([f.jobs.run(lease), f.jobs.run(lease)]), [
    { state: "completed" },
    { state: "completed" },
  ]);
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
  const pages = (await f.pages()).items;
  assert.equal(pages.length, 2);
  const timeoutPage = pages.find((page) => "deployment" in page.policy)!;
  assert.ok(timeoutPage);
  assert.equal(timeoutPage.policy.steps[0].target, "deployer");
  const incidentId = pagingWorkId(
    f.scope,
    "deployment-timeout-incident",
    "deploy",
  );
  assert.equal(timeoutPage.incidentId, incidentId);
  await f.finish();
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
  assert.equal((await f.get())!.deployment.finish?.outcome, "SUCCEEDED");
  assert.equal((await f.pages()).items.length, 2);
});
test("a finish before the timeout leaves no stuck incident", async () => {
  const f = await fixture();
  await f.start();
  f.time(599);
  await f.finish();
  f.time(600);
  await f.jobs.run(await f.claim());
  assert.equal((await f.get())!.deployment.status, "SUCCEEDED");
  assert.equal((await f.pages()).items.length, 1);
});
test("page/audit failure rolls deployment and all new paging records back", async () => {
  const f = await fixture();
  await f.start();
  f.time(600);
  const lease = await f.claim();
  const failing: StuckDeploymentRepository = {
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          audit: {
            ...tx.audit,
            append: async () => {
              throw new Error("Audit unavailable");
            },
          },
        }),
      ),
  };
  await assert.rejects(
    new StuckDeployments(failing).run(lease),
    /Audit unavailable/,
  );
  assert.equal((await f.get())!.deployment.status, "STARTED");
  assert.equal((await f.pages()).items.length, 1);
  await f.jobs.run(lease);
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
});
test("expired leases cannot create a timeout and a replacement claim recovers it", async () => {
  const f = await fixture();
  await f.start();
  f.time(600);
  const stale = await f.claim();
  f.time(611);
  await f.jobs.run(stale);
  assert.equal((await f.get())!.deployment.status, "STARTED");
  await f.jobs.run(await f.claim());
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
});
test("a backwards clock waits for the immutable deadline rather than paging early", async () => {
  const f = await fixture();
  await f.start();
  f.time(600);
  const lease = await f.claim();
  f.time(599);
  assert.deepEqual(await f.jobs.run(lease), { state: "wait", delayMs: 1000 });
  assert.equal((await f.get())!.deployment.status, "STARTED");
});
test("caller-edited lease hints cannot timeout a different deployment", async () => {
  const f = await fixture();
  await f.start();
  await f.start("other");
  f.time(600);
  const lease = await f.claim();
  const other = lease.payload.deploymentId === "deploy" ? "other" : "deploy";
  await assert.rejects(
    f.jobs.run({
      ...lease,
      payload: { ...lease.payload, deploymentId: other },
    }),
    /Invalid deployment timeout claim/,
  );
  assert.equal((await f.get())!.deployment.status, "STARTED");
  assert.equal((await f.get("other"))!.deployment.status, "STARTED");
});
test("deadline enqueue failure rolls the accepted deployment back", async () => {
  const f = await fixture();
  await assert.rejects(
    f.storage.withExtensions(f.scope, async (base, configuration) => {
      const tx = withDeploymentTimeout({
        ...configuration,
        ...base,
        work: {
          ...base.work,
          enqueue: async () => {
            throw new Error("Jobs unavailable");
          },
        },
      });
      const entry = await fixtureDeployment(tx, "deploy");
      await tx.deployments.insert(entry);
    }),
    /Jobs unavailable/,
  );
  assert.equal(await f.get(), undefined);
});
test("handler registration preserves existing lanes and rejects duplicate ownership", async () => {
  const f = await fixture();
  const existing = { job: new Map(), outbox: new Map() };
  const result = withDeploymentTimeoutHandlers(existing, f.repository);
  assert.equal(result.outbox, existing.outbox);
  assert.equal(existing.job.size, 0);
  assert.equal(result.job.size, 1);
  assert.throws(
    () => withDeploymentTimeoutHandlers(result, f.repository),
    /already registered/,
  );
});

test("accepted deadlines survive target disablement and grant revocation", async () => {
  const f = await fixture();
  await f.start();
  f.time(599);
  await f.repository.transaction(f.scope, async (tx) => {
    const target = (await tx.targets.get("target"))!;
    assert.equal(
      await tx.targets.replace(
        {
          ...target,
          enabled: false,
          revision: target.revision + 1,
          updatedAt: await tx.currentTime(),
        },
        target.revision,
      ),
      true,
    );
    assert.equal(await tx.tokens.revoke("target", "token"), true);
  });
  f.time(600);
  await f.jobs.run(await f.claim());
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
  assert.equal((await f.pages()).items.length, 2);
});
test("service disablement does not discard accepted timeout paging", async () => {
  const f = await fixture();
  await f.start();
  f.time(600);
  const disabled: StuckDeploymentRepository = {
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          services: {
            ...tx.services,
            get: async (id) => {
              const service = await tx.services.get(id);
              return service && { ...service, enabled: false };
            },
          },
        }),
      ),
  };
  await new StuckDeployments(disabled).run(await f.claim());
  assert.equal((await f.get())!.deployment.status, "TIMED_OUT");
  assert.equal((await f.pages()).items.length, 2);
});
