import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  responderIdSchema,
  escalationPolicySchema,
  workspaceIdSchema,
  writeDetectionBindingSchema,
  type Actor,
} from "../src/contracts/index.js";
import {
  DetectionManagement,
  type DetectionRepository,
} from "../src/application/index.js";
import { MemoryDetectionRepository } from "./conformance/memory-detection.js";
import { seedDetectionFixture } from "./conformance/detection.js";
async function fixture() {
  const repo = new MemoryDetectionRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("local"),
    responderId: responderIdSchema.parse("primary"),
    role: "administrator",
  };
  await repo.transaction(actor.workspaceId, seedDetectionFixture);
  const management = new DetectionManagement(repo, randomUUID);
  const input = writeDetectionBindingSchema.parse({
    serviceId: "api",
    environmentId: "prod",
    expectedVersion: null,
    enabled: false,
    policyId: null,
  });
  return { repo, actor, management, input };
}
test("configuration derives scope, preserves binding identity and audits each successful version", async () => {
  const f = await fixture();
  const first = await f.management.configure(f.actor, f.input);
  const second = await f.management.configure(f.actor, {
    ...f.input,
    expectedVersion: 1,
  });
  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.version, 2);
  assert.equal(second.workspaceId, f.actor.workspaceId);
  assert.deepEqual(
    await f.management.get(f.actor, {
      serviceId: f.input.serviceId,
      environmentId: f.input.environmentId,
    }),
    second,
  );
  await f.repo.transaction(f.actor.workspaceId, async (tx) => {
    const audit = (await tx.audit.list({ limit: 100 })).items;
    assert.equal(audit.length, 2);
    assert.ok(
      audit.every((row) => row.action === "detection.binding.configured"),
    );
  });
});
test("responders and viewers cannot change automatic paging, but can read its binding", async () => {
  const f = await fixture();
  for (const role of ["responder", "viewer"] as const) {
    const actor = { ...f.actor, role };
    await assert.rejects(f.management.configure(actor, f.input), {
      code: "forbidden",
    });
    assert.equal(
      await f.management.get(actor, {
        serviceId: f.input.serviceId,
        environmentId: f.input.environmentId,
      }),
      undefined,
    );
  }
});
test("parallel writes using the same version have one winner and one audit", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([
    f.management.configure(f.actor, f.input),
    f.management.configure(f.actor, f.input),
  ]);
  assert.equal(
    outcomes.filter((value) => value.status === "fulfilled").length,
    1,
  );
  const failure = outcomes.find((value) => value.status === "rejected");
  assert.equal(failure?.reason.code, "conflict");
  await f.repo.transaction(f.actor.workspaceId, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1),
  );
});
test("audit failure rolls back binding creation and missing scoped references do not bind", async () => {
  const f = await fixture();
  const broken: DetectionRepository = {
    transaction: (scope, run) =>
      f.repo.transaction(scope, (tx) =>
        run({
          ...tx,
          audit: {
            ...tx.audit,
            append: async () => {
              throw new Error("audit failed");
            },
          },
        }),
      ),
  };
  await assert.rejects(
    new DetectionManagement(broken, randomUUID).configure(f.actor, f.input),
    /audit failed/,
  );
  assert.equal(
    await f.management.get(f.actor, {
      serviceId: f.input.serviceId,
      environmentId: f.input.environmentId,
    }),
    undefined,
  );
  await assert.rejects(
    f.management.configure(f.actor, {
      ...f.input,
      enabled: true,
      policyId: "foreign-policy",
    }),
    { code: "not_found" },
  );
  assert.equal(
    writeDetectionBindingSchema.safeParse({
      ...f.input,
      workspaceId: "foreign",
    }).success,
    false,
  );
  assert.equal(
    writeDetectionBindingSchema.safeParse({ ...f.input, enabled: true })
      .success,
    false,
  );
});

test("automatic paging requires an enabled reviewed policy and can be disabled after that policy changes", async () => {
  const f = await fixture();
  const policyId = await f.repo.transaction(f.actor.workspaceId, async (tx) => {
    const page = (await tx.pages.get("page"))!;
    const schedule = {
      id: escalationPolicySchema.parse(page.policy).primaryScheduleId,
      workspaceId: f.actor.workspaceId,
      serviceId: page.policy.serviceId,
      name: "Primary",
      version: 1,
      enabled: true,
      rotations: [],
      overrides: [],
    };
    await tx.configuration.schedules.put(schedule, null);
    await tx.configuration.previews.insert({
      id: "preview",
      workspaceId: f.actor.workspaceId,
      serviceId: schedule.serviceId,
      scheduleId: schedule.id,
      scheduleVersion: 1,
      createdAt: tx.now,
      startsAt: tx.now,
      endsAt: "2026-09-21T00:00:00.000Z",
      intervals: [
        {
          startsAt: tx.now,
          endsAt: "2026-09-21T00:00:00.000Z",
          assignment: null,
        },
      ],
    });
    const policy = {
      ...escalationPolicySchema.parse(page.policy),
      peerScheduleId: schedule.id,
      enabled: true,
      primaryPreviewId: "preview",
      peerPreviewId: "preview",
    };
    await tx.configuration.policies.put(policy, null);
    return policy.id;
  });
  const binding = await f.management.configure(f.actor, {
    ...f.input,
    enabled: true,
    policyId,
  });
  assert.equal(binding.enabled, true);
  await f.repo.transaction(f.actor.workspaceId, async (tx) => {
    const policy = (await tx.configuration.policies.get(policyId))!;
    await tx.configuration.policies.put(
      { ...policy, version: 2, enabled: false },
      1,
    );
  });
  await assert.rejects(
    f.management.configure(f.actor, {
      ...f.input,
      expectedVersion: 1,
      enabled: true,
      policyId,
    }),
    { code: "invalid_configuration" },
  );
  const disabled = await f.management.configure(f.actor, {
    ...f.input,
    expectedVersion: 1,
    policyId,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.version, 2);
});
