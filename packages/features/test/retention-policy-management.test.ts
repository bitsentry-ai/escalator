import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  workspaceSchema,
  defaultReplayRetention,
  type Actor,
} from "../src/contracts/index.js";
import {
  RetentionPolicyManagement,
  type RetentionPolicyTransaction,
} from "../src/application/retention/policy-management.js";
import { MemoryRetentionPolicyRepository } from "./conformance/memory-retention-policy.js";
const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("retention"),
  responderId: responderIdSchema.parse("admin"),
  role: "administrator",
};
async function fixture(id: () => string = () => randomUUID()) {
  const repo = new MemoryRetentionPolicyRepository();
  await repo.transaction(actor.workspaceId, async (tx) =>
    tx.workspace.insert(
      workspaceSchema.parse({
        id: actor.workspaceId,
        name: "Team",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    ),
  );
  return { repo, management: new RetentionPolicyManagement(repo, id) };
}
const input = { ...defaultReplayRetention, expectedVersion: null };
test("reading defaults does not create a policy revision or audit", async () => {
  const { repo, management } = await fixture();
  const result = await management.get(actor);
  assert.equal(result.configured, null);
  assert.deepEqual(result.effective, defaultReplayRetention);
  await repo.transaction(actor.workspaceId, async (tx) => {
    assert.equal(await tx.retentionPolicy.get(), undefined);
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
  });
});
test("only administrators can change retention and no request can raise deployment ceilings", async () => {
  const { management } = await fixture();
  for (const role of ["viewer", "responder"] as const)
    await assert.rejects(
      management.save({ ...actor, role }, input),
      /forbidden/,
    );
  await assert.rejects(
    management.save(actor, { ...input, maxBytes: 10 * 1024 ** 3 }),
    /capacity/,
  );
  await assert.rejects(
    management.save(actor, { ...input, workspaceId: "other" } as typeof input),
  );
  assert.equal((await management.get(actor)).configured, null);
});
test("one of two edits from the same version wins and produces one audit", async () => {
  const { repo, management } = await fixture();
  const results = await Promise.allSettled([
    management.save(actor, { ...input, days: 10 }),
    management.save(actor, { ...input, days: 20 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await management.get(actor)).configured?.version, 1);
  await repo.transaction(actor.workspaceId, async (tx) => {
    const audit = (await tx.audit.list({ limit: 100 })).items;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, "retention.policy.updated");
  });
});
test("an audit failure rolls back the policy compare-and-swap", async () => {
  const { management } = await fixture(() => "one-audit");
  await management.save(actor, input);
  await assert.rejects(
    management.save(actor, { ...input, expectedVersion: 1, days: 2 }),
    /already_exists/,
  );
  const saved = (await management.get(actor)).configured;
  assert.equal(saved?.version, 1);
  assert.equal(saved?.days, 30);
});
test("lower deployment ceilings are visible separately from the saved policy", async () => {
  const { repo, management } = await fixture();
  await management.save(actor, { ...input, days: 180 });
  const restricted = new RetentionPolicyManagement(repo, randomUUID, {
    days: 14,
    maxBytes: 1024 ** 2,
  });
  const result = await restricted.get(actor);
  assert.equal(result.configured?.days, 180);
  assert.equal(result.effective.days, 14);
  assert.equal(result.effective.maxBytes, 1024 ** 2);
  assert.equal((await management.get(actor)).configured?.version, 1);
});
test("policy handles expire and caught cross-scope writes poison the whole transaction", async () => {
  const { repo } = await fixture();
  let handle: RetentionPolicyTransaction | undefined;
  await repo.transaction(actor.workspaceId, async (tx) => {
    handle = tx;
  });
  await assert.rejects(handle!.retentionPolicy.get(), /closed_transaction/);
  await assert.rejects(
    repo.transaction(actor.workspaceId, async (tx) => {
      await assert.rejects(
        tx.retentionPolicy.put(
          {
            ...defaultReplayRetention,
            workspaceId: workspaceIdSchema.parse("other"),
            version: 1,
            updatedAt: tx.now,
          },
          null,
        ),
        /scope_violation/,
      );
    }),
    /scope_violation/,
  );
  await repo.transaction(actor.workspaceId, async (tx) =>
    assert.equal(await tx.retentionPolicy.get(), undefined),
  );
});
