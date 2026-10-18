import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  StuckDeployments,
  finishDeployment,
  pagingWorkId,
  type StuckDeploymentRepository,
  type DeploymentRepository,
} from "@bitsentry-escalator/features/application";
import {
  seedDeploymentFixture,
  fixtureDeployment,
  type DeploymentFixture,
} from "./deployments.js";
export interface StuckFixture extends DeploymentFixture {
  repository: StuckDeploymentRepository &
    Pick<DeploymentRepository, "findTokenContext">;
}
/** The same scoped transaction/concurrency cases run against memory and both PostgreSQL hosts. */
export function stuckConformance(
  name: string,
  create: () => Promise<StuckFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  function scenario(
    title: string,
    run: (
      f: StuckFixture,
      scope: WorkspaceId,
      other: WorkspaceId,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const f = await create(),
        scope = workspaceIdSchema.parse(`stuck_${randomUUID()}`),
        other = workspaceIdSchema.parse(`stuck_${randomUUID()}`);
      try {
        for (const id of [scope, other]) await seedDeploymentFixture(f, id);
        await run(f, scope, other);
      } finally {
        await f.dispose();
      }
    });
  }
  const start = (f: StuckFixture, scope: WorkspaceId) =>
    f.repository.transaction(scope, async (tx) => {
      const entry = await fixtureDeployment(tx, "deploy", true);
      await tx.deployments.insert(entry);
      return entry;
    });
  const claim = async (f: StuckFixture, scope: WorkspaceId) => {
    const value = await f.work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["deployment.timeout"],
      token: randomUUID(),
      leaseMs: 60000,
    });
    assert.ok(value);
    return value;
  };
  const entry = (f: StuckFixture, scope: WorkspaceId) =>
    f.repository.transaction(scope, (tx) =>
      tx.deployments.get("target", "deploy"),
    );
  const pageId = (scope: WorkspaceId) =>
    pagingWorkId(
      scope,
      "page",
      pagingWorkId(scope, "deployment-timeout-incident", "deploy"),
    );
  const page = (f: StuckFixture, scope: WorkspaceId) =>
    f.repository.transaction(scope, (tx) => tx.pages.get(pageId(scope)));
  async function finish(f: StuckFixture, scope: WorkspaceId) {
    return f.repository.transaction(scope, async (tx) => {
      await tx.targets.get("target");
      const current = (await tx.deployments.get("target", "deploy"))!
        .deployment;
      const at = await tx.currentTime();
      const transition = finishDeployment(
        current,
        {
          version: 1,
          source: current.source,
          externalId: current.externalId,
          environmentId: current.environmentId,
          actor: "ci",
          occurredAt: at,
          outcome: "SUCCEEDED",
        },
        at,
      );
      if (transition.state !== "changed")
        throw new Error("Fixture finish was rejected");
      assert.equal(
        await tx.deployments.replace(
          "target",
          transition.deployment,
          current.revision,
        ),
        true,
      );
    });
  }
  scenario(
    "caught validation failures poison the whole accepted-start transaction",
    async (f, scope) => {
      await assert.rejects(
        f.repository.transaction(scope, async (tx) => {
          const valid = await fixtureDeployment(tx, "deploy", true);
          await tx.deployments.insert(valid);
          // The caller deliberately catches a malformed second insert. The first
          // deployment and its deadline must still roll back at the repository boundary.
          await assert.rejects(
            tx.deployments.insert({
              ...valid,
              deployment: { ...valid.deployment, revision: 0 },
            }),
          );
        }),
      );
      assert.equal(await entry(f, scope), undefined);
      assert.equal(
        await f.work.claim({
          workspaceId: scope,
          queue: "job",
          kinds: ["deployment.timeout"],
          token: randomUUID(),
          leaseMs: 60000,
        }),
        undefined,
      );
    },
  );
  scenario("start and its deadline roll back together", async (f, scope) => {
    await assert.rejects(
      f.repository.transaction(scope, async (tx) => {
        await tx.deployments.insert(
          await fixtureDeployment(tx, "deploy", true),
        );
        throw new Error("Abort accepted start");
      }),
      /Abort accepted start/,
    );
    assert.equal(await entry(f, scope), undefined);
    assert.equal(
      await f.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["deployment.timeout"],
        token: randomUUID(),
        leaseMs: 60000,
      }),
      undefined,
    );
    const saved = await start(f, scope);
    const lease = await claim(f, scope);
    assert.equal(lease.payload.deploymentId, saved.deployment.id);
    assert.equal(lease.dueAt, saved.deployment.timeoutAt);
  });
  scenario(
    "timeout state, page, deadlines and audit roll back on audit failure",
    async (f, scope) => {
      await start(f, scope);
      const lease = await claim(f, scope);
      const failing: StuckDeploymentRepository = {
        transaction: (id, run) =>
          f.repository.transaction(id, (tx) =>
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
      assert.equal((await entry(f, scope))!.deployment.status, "STARTED");
      assert.equal(await page(f, scope), undefined);
      assert.equal(
        await f.work.claim({
          workspaceId: scope,
          queue: "job",
          kinds: ["paging.step"],
          token: randomUUID(),
          leaseMs: 60000,
        }),
        undefined,
      );
      await new StuckDeployments(f.repository).run(lease);
      assert.equal((await entry(f, scope))!.deployment.status, "TIMED_OUT");
      assert.ok(await page(f, scope));
    },
  );
  scenario(
    "concurrent retries create exactly one immutable timeout page",
    async (f, scope, other) => {
      await start(f, scope);
      const lease = await claim(f, scope);
      const jobs = new StuckDeployments(f.repository);
      await Promise.all([jobs.run(lease), jobs.run(lease)]);
      const saved = (await page(f, scope))!;
      assert.ok(saved);
      assert.ok("deployment" in saved.policy);
      assert.equal(saved.policy.deployment.id, "deploy");
      assert.equal(
        (
          await f.repository.transaction(scope, (tx) =>
            tx.pages.list({ limit: 100 }),
          )
        ).items.length,
        2,
      );
      assert.equal(
        await f.repository.transaction(other, (tx) => tx.pages.get(saved.id)),
        undefined,
      );
      await jobs.run(lease);
      assert.deepEqual(await page(f, scope), saved);
    },
  );
  scenario(
    "wrong lease token cannot commit timeout state",
    async (f, scope) => {
      await start(f, scope);
      const lease = await claim(f, scope);
      const jobs = new StuckDeployments(f.repository);
      await jobs.run({ ...lease, token: randomUUID() });
      assert.equal((await entry(f, scope))!.deployment.status, "STARTED");
      assert.equal(await page(f, scope), undefined);
      await jobs.run(lease);
      assert.equal((await entry(f, scope))!.deployment.status, "TIMED_OUT");
    },
  );
  scenario(
    "finish racing timeout preserves one coherent outcome",
    async (f, scope) => {
      await start(f, scope);
      const lease = await claim(f, scope);
      await Promise.all([
        new StuckDeployments(f.repository).run(lease),
        finish(f, scope),
      ]);
      const deployment = (await entry(f, scope))!.deployment;
      assert.equal(deployment.finish?.outcome, "SUCCEEDED");
      if (deployment.status === "TIMED_OUT") assert.ok(await page(f, scope));
      else {
        assert.equal(deployment.status, "SUCCEEDED");
        assert.equal(await page(f, scope), undefined);
      }
    },
  );
  scenario(
    "late completion keeps the timeout page and its policy",
    async (f, scope) => {
      await start(f, scope);
      await new StuckDeployments(f.repository).run(await claim(f, scope));
      const saved = await page(f, scope);
      await finish(f, scope);
      assert.equal((await entry(f, scope))!.deployment.status, "TIMED_OUT");
      assert.equal(
        (await entry(f, scope))!.deployment.finish?.outcome,
        "SUCCEEDED",
      );
      assert.deepEqual(await page(f, scope), saved);
    },
  );
}
