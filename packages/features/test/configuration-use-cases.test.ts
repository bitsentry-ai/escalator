import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConfigurationRepository } from "./conformance/memory-configuration.js";
import { seedPagingFixture } from "./conformance/paging.js";
import { ConfigurationUseCases } from "../src/application/configuration/configuration.use-cases.js";
import {
  workspaceIdSchema,
  escalationPolicySchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
async function fixture() {
  const repository = new MemoryConfigurationRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("configuration-api"),
    responderId: responderIdSchema.parse("primary"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedPagingFixture);
  let sequence = 0;
  return {
    repository,
    actor,
    app: new ConfigurationUseCases(
      repository,
      () => `configuration-${++sequence}`,
    ),
  };
}
const schedule = {
  id: "schedule",
  serviceId: "api",
  name: "Primary",
  enabled: true,
  rotations: [],
  overrides: [],
  expectedVersion: null,
};
test("configuration API creates an audited schedule and immutable gap preview", async () => {
  const { repository, actor, app } = await fixture();
  const saved = await app.writeSchedule(actor, schedule);
  assert.equal(saved.version, 1);
  const preview = await app.preview(actor, {
    scheduleId: saved.id,
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(preview.intervals.length, 1);
  assert.equal(preview.intervals[0].assignment, null);
  assert.equal(preview.createdAt, "2026-09-20T00:00:00.000Z");
  assert.deepEqual(
    await app.get(actor, "previews", { id: preview.id }),
    preview,
  );
  const audit = await repository.transaction(actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.ok(audit.items.some((row) => row.action === "schedule.configured"));
  assert.ok(
    audit.items.some((row) => row.action === "schedule_preview.configured"),
  );
});
test("configuration API rejects viewer writes and caller-supplied scope", async () => {
  const { actor, app } = await fixture();
  await assert.rejects(
    app.writeSchedule({ ...actor, role: "viewer" }, schedule),
    { code: "forbidden" },
  );
  await assert.rejects(
    app.writeSchedule(actor, {
      ...schedule,
      workspaceId: "foreign",
    } as typeof schedule),
  );
  assert.equal((await app.list(actor, "schedules")).items.length, 0);
});
test("configuration API preserves a concurrent edit and scopes reads", async () => {
  const { actor, app } = await fixture();
  await app.writeSchedule(actor, schedule);
  const results = await Promise.allSettled([
    app.writeSchedule(actor, {
      ...schedule,
      name: "First",
      expectedVersion: 1,
    }),
    app.writeSchedule(actor, {
      ...schedule,
      name: "Second",
      expectedVersion: 1,
    }),
  ]);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (await app.get(actor, "schedules", { id: schedule.id })).version,
    2,
  );
  const foreign = { ...actor, workspaceId: workspaceIdSchema.parse("foreign") };
  await assert.rejects(app.get(foreign, "schedules", { id: schedule.id }), {
    code: "not_found",
  });
  assert.equal((await app.list(foreign, "schedules")).items.length, 0);
});
test("configuration mutation rolls back when its audit append fails", async () => {
  const { repository, actor } = await fixture();
  const app = new ConfigurationUseCases(
    {
      transaction: (scope, run) =>
        repository.transaction(scope, (tx) =>
          run({
            ...tx,
            audit: {
              ...tx.audit,
              append: async () => {
                throw new Error("audit unavailable");
              },
            },
          }),
        ),
    },
    () => "audit-rollback",
  );
  await assert.rejects(app.writeSchedule(actor, schedule), /audit unavailable/);
  await repository.transaction(actor.workspaceId, async (tx) => {
    assert.equal(
      await tx.configuration.schedules.get(
        schedule.id as Parameters<typeof tx.configuration.schedules.get>[0],
      ),
      undefined,
    );
  });
});
test("policy activation requires a preview of the current schedule revision", async () => {
  const { repository, actor, app } = await fixture();
  const saved = await app.writeSchedule(actor, schedule);
  const preview = await app.preview(actor, {
    scheduleId: saved.id,
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: "2026-09-21T00:00:00.000Z",
  });
  const policy = await repository.transaction(actor.workspaceId, async (tx) =>
    escalationPolicySchema.parse((await tx.pages.get("page"))!.policy),
  );
  const input = {
    id: policy.id,
    serviceId: policy.serviceId,
    primaryScheduleId: saved.id,
    peerScheduleId: saved.id,
    fallbackResponderIds: policy.fallbackResponderIds,
    steps: policy.steps,
    terminal: policy.terminal,
    enabled: true,
    primaryPreviewId: preview.id,
    peerPreviewId: preview.id,
    expectedVersion: null,
  };
  const active = await app.writePolicy(actor, input);
  assert.equal(active.version, 1);
  await app.writeSchedule(actor, {
    ...schedule,
    name: "Updated",
    expectedVersion: 1,
  });
  await assert.rejects(
    app.writePolicy(actor, { ...input, expectedVersion: 1 }),
    { code: "stale_preview" },
  );
  assert.equal(
    (await app.get(actor, "policies", { id: policy.id })).version,
    1,
  );
});
test("viewers inspect coverage without creating a reviewed preview", async () => {
  const { actor, app } = await fixture();
  await app.writeSchedule(actor, schedule);
  const viewer = { ...actor, role: "viewer" as const };
  const input = {
    scheduleId: schedule.id,
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: "2026-09-21T00:00:00.000Z",
  };
  assert.equal(
    (await app.coverage(viewer, input)).intervals[0].assignment,
    null,
  );
  assert.equal((await app.list(actor, "previews")).items.length, 0);
  await assert.rejects(app.preview(viewer, input), { code: "forbidden" });
});
test("malformed policy rules return a validation error before persistence", async () => {
  const { repository, actor, app } = await fixture();
  const policy = await repository.transaction(actor.workspaceId, async (tx) =>
    escalationPolicySchema.parse((await tx.pages.get("page"))!.policy),
  );
  const input = {
    id: policy.id,
    serviceId: policy.serviceId,
    primaryScheduleId: policy.primaryScheduleId,
    peerScheduleId: policy.peerScheduleId,
    fallbackResponderIds: policy.fallbackResponderIds,
    steps: policy.steps,
    terminal: policy.terminal,
    enabled: false,
    primaryPreviewId: null,
    peerPreviewId: null,
    expectedVersion: null,
  };
  await assert.rejects(app.writePolicy(actor, { ...input, enabled: true }), {
    code: "invalid_configuration",
  });
  await assert.rejects(
    app.writePolicy(actor, {
      ...input,
      steps: input.steps.map((step, i) =>
        i === 0 ? { ...step, offsetMs: 1 } : step,
      ),
    }),
    { code: "invalid_configuration" },
  );
  assert.equal((await app.list(actor, "policies")).items.length, 0);
});

test("saved preview selection is bounded and cannot cross schedule or workspace scope", async () => {
  const { actor, app } = await fixture();
  await app.writeSchedule(actor, schedule);
  await app.writeSchedule(actor, { ...schedule, id: "other" });
  const range = {
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: "2026-09-21T00:00:00.000Z",
  };
  const first = await app.preview(actor, { ...range, scheduleId: "schedule" });
  const second = await app.preview(actor, { ...range, scheduleId: "schedule" });
  await app.preview(actor, { ...range, scheduleId: "other" });
  const page = await app.previews(
    { ...actor, role: "viewer" },
    { scheduleId: "schedule", limit: 1 },
  );
  assert.deepEqual(
    page.items.map((row) => row.id),
    [first.id],
  );
  const next = await app.previews(actor, {
    scheduleId: "schedule",
    limit: 1,
    after: page.next!,
  });
  assert.deepEqual(
    next.items.map((row) => row.id),
    [second.id],
  );
  assert.equal(next.next, null);
  await assert.rejects(
    app.previews(
      { ...actor, workspaceId: workspaceIdSchema.parse("foreign") },
      { scheduleId: "schedule" },
    ),
    { code: "not_found" },
  );
  await assert.rejects(
    app.previews(actor, { scheduleId: "schedule", limit: 51 }),
  );
});
