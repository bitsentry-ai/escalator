import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
import { DeploymentQueries } from "../src/application/deploy/queries.js";
import { DeploymentManagement } from "../src/application/deploy/management.js";
import type { DeploymentWatchRepository } from "../src/application/deploy/watch-persistence.js";
import { MemoryDeploymentWatchRepository } from "./conformance/memory-deployment-watches.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";

async function fixture() {
  const repository = new MemoryDeploymentWatchRepository({
    now: () => new Date("2026-10-05T00:00:00.000Z"),
  });
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("history"),
    responderId: responderIdSchema.parse("primary"),
    role: "viewer",
  };
  const f = {
    repository,
    configuration: repository.configuration,
    work: repository.work,
    dispose: async () => {},
  };
  await seedDeploymentFixture(f, actor.workspaceId);
  await repository.transaction(actor.workspaceId, async (tx) => {
    for (const id of ["a", "b", "c"])
      await tx.deployments.insert(await fixtureDeployment(tx, id));
  });
  return { ...f, actor, queries: new DeploymentQueries(repository) };
}
test("human deployment history is bounded, resumable and omits captured paging policy", async () => {
  const f = await fixture();
  const first = await f.queries.history(f.actor, {
    targetId: "target",
    limit: 2,
  });
  assert.equal(first.items.length, 2);
  assert.ok(first.next);
  const second = await f.queries.history(f.actor, {
    targetId: "target",
    limit: 2,
    after: first.next,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.next, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => x.id)).size,
    3,
  );
  for (const value of [...first.items, ...second.items]) {
    assert.equal("policy" in value, false);
    assert.equal("tokenHash" in value, false);
  }
  await assert.rejects(
    f.queries.history(f.actor, { targetId: "target", limit: 101 }),
  );
  await assert.rejects(
    f.queries.history(f.actor, { targetId: "target", workspaceId: "other" }),
  );
});
test("viewer sessions inspect disabled targets without machine credentials or background writes", async () => {
  const f = await fixture();
  const before = await f.queries.detail(f.actor, {
    targetId: "target",
    id: "a",
  });
  const management = new DeploymentManagement(f.repository, randomUUID);
  await management.update(
    { ...f.actor, role: "administrator" },
    {
      id: "target",
      expectedRevision: 1,
      name: "Archived",
      enabled: false,
      policyId: "policy",
      timeoutSeconds: 600,
    },
  );
  const after = await f.queries.detail(f.actor, {
    targetId: "target",
    id: "a",
  });
  assert.deepEqual(after, before);
  assert.equal(after.watch, null);
  assert.equal(after.baselineAvailable, true);
  assert.equal(
    (await f.queries.history(f.actor, { targetId: "target" })).items.length,
    3,
  );
});
test("history and watch detail stay within the host-derived workspace and target", async () => {
  const f = await fixture();
  const other = {
    ...f.actor,
    workspaceId: workspaceIdSchema.parse("other-history"),
  };
  await seedDeploymentFixture(f, other.workspaceId);
  assert.deepEqual(await f.queries.history(other, { targetId: "target" }), {
    items: [],
    next: null,
  });
  await assert.rejects(
    f.queries.detail(other, { targetId: "target", id: "a" }),
    { code: "not_found" },
  );
  await assert.rejects(
    f.queries.detail(f.actor, { targetId: "missing", id: "a" }),
    { code: "not_found" },
  );
  await assert.rejects(
    f.queries.detail(f.actor, { targetId: "target", id: "../a" }),
  );
});
test("human read projections fail closed when a storage adapter returns another target's row", async () => {
  const f = await fixture();
  const repository: DeploymentWatchRepository = {
    transaction: (scope, run) =>
      f.repository.transaction(scope, (tx) =>
        run({
          ...tx,
          deployments: {
            ...tx.deployments,
            get: async (target, id) => {
              const row = await tx.deployments.get(target, id);
              return row ? { ...row, targetId: "foreign" } : undefined;
            },
            list: async (target, page) => {
              const rows = await tx.deployments.list(target, page);
              return {
                ...rows,
                items: rows.items.map((row) => ({
                  ...row,
                  targetId: "foreign",
                })),
              };
            },
          },
        }),
      ),
  };
  const queries = new DeploymentQueries(repository);
  await assert.rejects(
    queries.detail(f.actor, { targetId: "target", id: "a" }),
    { code: "scope_violation" },
  );
  await assert.rejects(queries.history(f.actor, { targetId: "target" }), {
    code: "scope_violation",
  });
});
