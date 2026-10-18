import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PageCreation } from "../src/application/paging/create-page.js";
import { PageAdvancement } from "../src/application/paging/advance.js";
import { type DispatchRepository } from "../src/application/paging/routing.js";
import { defaultEscalationPolicy } from "../src/domain/escalation/ladder.js";
import {
  pagingContactSchema,
  escalationPolicySchema,
  scheduleSchema,
  workspaceIdSchema,
} from "../src/contracts/index.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";

async function fixture() {
  let now = new Date("2026-09-20T00:00:00.000Z");
  const scope = workspaceIdSchema.parse("dispatch-test");
  const repository = new MemoryPagingRepository({ now: () => now });
  await repository.transaction(scope, seedPagingFixture);
  const original = await repository.transaction(
    scope,
    async (tx) => (await tx.pages.get("page"))!.policy,
  );
  const policy = escalationPolicySchema.parse(
    defaultEscalationPolicy(escalationPolicySchema.parse(original)),
  );
  const schedules = new Map(
    ["primary", "peer"].map((id) => [
      id,
      scheduleSchema.parse({
        id,
        workspaceId: scope,
        serviceId: "api",
        name: id,
        version: 1,
        enabled: true,
        rotations: [
          {
            id: "rotation",
            timeZone: "UTC",
            anchorLocal: "2026-01-01T00:00",
            shiftDays: 1,
            responders: [id],
          },
        ],
        overrides: [],
      }),
    ]),
  );
  const contacts = ["primary", "peer"].map((id) =>
    pagingContactSchema.parse({
      id: "contact-" + id,
      workspaceId: scope,
      responderId: id,
      channel: "webhook",
      secretId: "secret-" + id,
      enabled: true,
      priority: 0,
    }),
  );
  const dispatchRepository: DispatchRepository = {
    transaction: (workspace, run) =>
      repository.transaction(workspace, (tx) =>
        run({
          ...tx,
          routing: {
            schedule: async (id) => schedules.get(id),
            contacts: async (id) =>
              contacts.filter((contact) => contact.responderId === id),
          },
        }),
      ),
  };
  const input = {
    incident: {
      id: "new-incident",
      serviceId: policy.serviceId,
      environmentId: (
        await repository.transaction(
          scope,
          async (tx) => (await tx.incidents.get("incident"))!,
        )
      ).environmentId,
      title: "API unavailable",
      severity: "critical" as const,
    },
    policy,
  };
  const claim = () =>
    repository.foundation.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["paging.step"],
      token: randomUUID(),
      leaseMs: 5000,
    });
  return {
    scope,
    repository,
    input,
    schedules,
    contacts,
    claim,
    setNow: (value: string) => {
      now = new Date(value);
    },
    creation: new PageCreation(repository),
    advancement: new PageAdvancement(dispatchRepository),
  };
}
test("incident, immutable policy, all deadlines and audit are created idempotently", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    f.creation.open(f.scope, f.input),
    f.creation.open(f.scope, f.input),
  ]);
  assert.deepEqual(a, b);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1);
    assert.equal((await tx.pages.get(a.id))?.policy.steps.length, 5);
  });
  await assert.rejects(
    f.creation.open(f.scope, {
      ...f.input,
      incident: { ...f.input.incident, title: "changed" },
    }),
  );
  const claim = (await f.claim())!;
  assert.equal(claim.kind, "paging.step");
  assert.equal(claim.payload.pageId, a.id);
});
test("dispatch freezes the selected recipient and approved secret reference across reclaim", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  const lease = (await f.claim())!;
  assert.deepEqual(await f.advancement.advance(lease), { state: "completed" });
  f.contacts[0]!.enabled = false;
  await f.repository.foundation.expireLease(lease);
  const reclaimed = (await f.claim())!;
  await f.advancement.advance(reclaimed);
  await f.repository.transaction(f.scope, async (tx) => {
    const deliveries = (await tx.deliveries.forPage(page.id, { limit: 100 }))
      .items;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.recipientId, "primary");
    assert.equal(
      (await tx.steps.forPage(page.id, { limit: 100 })).items.length,
      1,
    );
  });
  const send = await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "outbox",
    kinds: ["paging.send"],
    token: randomUUID(),
    leaseMs: 5000,
  });
  assert.deepEqual(send?.payload.approvedSecretIds, ["secret-primary"]);
});
test("restart dispatches only the current overdue level and persists obsolete skips", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  f.setNow("2026-09-20T00:13:00.000Z");
  const lease = (await f.claim())!;
  await f.advancement.advance(lease);
  await f.repository.transaction(f.scope, async (tx) => {
    const steps = (await tx.steps.forPage(page.id, { limit: 100 })).items;
    assert.equal(
      steps.filter((step) => step.disposition === "skipped").length,
      3,
    );
    assert.deepEqual(
      steps.find((step) => step.disposition === "dispatch")?.recipientIds,
      ["peer"],
    );
    assert.equal(
      (await tx.deliveries.forPage(page.id, { limit: 100 })).items.length,
      1,
    );
  });
});
test("expired claims do not resolve recipients or create delivery intents", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  const lease = (await f.claim())!;
  await f.repository.foundation.expireLease(lease);
  await f.advancement.advance(lease);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.steps.forPage(page.id, { limit: 100 })).items.length,
      0,
    );
    assert.equal(
      (await tx.deliveries.forPage(page.id, { limit: 100 })).items.length,
      0,
    );
  });
});
test("missing coverage is explicit and fallback exhaustion never resolves a page", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  f.contacts.forEach((contact) => {
    contact.enabled = false;
  });
  f.setNow("2026-09-20T00:17:00.000Z");
  await f.advancement.advance((await f.claim())!);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal((await tx.pages.get(page.id))?.state, "exhausted");
    assert.equal((await tx.pages.get(page.id))?.resolvedAt, null);
    assert.ok(
      (await tx.steps.forPage(page.id, { limit: 100 })).items.some(
        (step) => step.disposition === "uncovered",
      ),
    );
  });
});
test("a clock rewind between claim and dispatch preserves the unprocessed deadline", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  const lease = (await f.claim())!;
  f.setNow("2026-09-19T23:59:59.000Z");
  assert.deepEqual(await f.advancement.advance(lease), {
    state: "retry",
    delayMs: 1000,
  });
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.steps.forPage(page.id, { limit: 100 })).items.length,
      0,
    );
  });
});
test("advancing cancels an older outbox lease and schedules provider cancellation", async () => {
  const f = await fixture();
  f.contacts[0]!.channel = "pushover";
  const page = await f.creation.open(f.scope, f.input);
  await f.advancement.advance((await f.claim())!);
  const oldSend = (await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "outbox",
    kinds: ["paging.send"],
    token: randomUUID(),
    leaseMs: 5000,
  }))!;
  f.setNow("2026-09-20T00:02:00.000Z");
  await f.advancement.advance((await f.claim())!);
  assert.equal(await f.repository.foundation.committed(oldSend), false);
  assert.equal(
    await f.repository.foundation.settle(oldSend, {
      state: "completed",
      outcome: "accepted",
    }),
    false,
  );
  const cancel = await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: ["paging.cancel"],
    token: randomUUID(),
    leaseMs: 5000,
  });
  assert.equal(cancel?.payload.deliveryId, oldSend.payload.deliveryId);
  assert.equal(cancel?.payload.pageId, page.id);
  const next = await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "outbox",
    kinds: ["paging.send"],
    token: randomUUID(),
    leaseMs: 5000,
  });
  assert.notEqual(next?.payload.deliveryId, oldSend.payload.deliveryId);
});
test("concurrent processing of one claimed deadline creates one logical delivery", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  const lease = (await f.claim())!;
  await Promise.all([
    f.advancement.advance(lease),
    f.advancement.advance(lease),
  ]);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.steps.forPage(page.id, { limit: 100 })).items.length,
      1,
    );
    assert.equal(
      (await tx.deliveries.forPage(page.id, { limit: 100 })).items.length,
      1,
    );
  });
});
test("recipient resolution uses the step deadline rather than delayed dispatch time", async () => {
  const f = await fixture();
  const peer = f.schedules.get("peer")!;
  peer.overrides.push({
    id: "temporary",
    responderId: f.contacts[0]!.responderId,
    startsAt: "2026-09-20T00:12:00.000Z",
    endsAt: "2026-09-20T00:12:30.000Z",
    approved: true,
  });
  const page = await f.creation.open(f.scope, f.input);
  f.setNow("2026-09-20T00:13:00.000Z");
  await f.advancement.advance((await f.claim())!);
  await f.repository.transaction(f.scope, async (tx) => {
    const steps = (await tx.steps.forPage(page.id, { limit: 100 })).items;
    const active = steps.find((step) => step.disposition === "dispatch")!;
    assert.equal(active.dueAt, "2026-09-20T00:12:00.000Z");
    assert.deepEqual(active.recipientIds, ["primary"]);
  });
});
test("failure to append the opening audit rolls back incident, page and deadlines", async () => {
  const f = await fixture();
  const creation = new PageCreation({
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
  });
  await assert.rejects(creation.open(f.scope, f.input));
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(await tx.incidents.get(f.input.incident.id), undefined);
    assert.equal((await tx.pages.list({ limit: 100 })).items.length, 1);
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
  });
  assert.equal(await f.claim(), undefined);
});
test("a foreign contact fails the step instead of paging anyone", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  f.contacts[0]!.workspaceId = workspaceIdSchema.parse("foreign");
  await assert.rejects(
    f.advancement.advance((await f.claim())!),
    /Invalid contact scope/,
  );
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.deliveries.forPage(page.id, { limit: 100 })).items.length,
      0,
    );
  });
});

test("invalid and excessive stored contacts do not block a usable route", async () => {
  const f = await fixture();
  const good = f.contacts[0]!;
  f.contacts.unshift({ ...good, id: "invalid", priority: -1 });
  for (let i = 0; i < 101; i++)
    f.contacts.push({ ...good, id: `extra-${i}`, enabled: false });
  const page = await f.creation.open(f.scope, f.input);
  assert.equal(
    (await f.advancement.advance((await f.claim())!)).state,
    "completed",
  );
  await f.repository.transaction(f.scope, async (tx) => {
    const deliveries = (await tx.deliveries.forPage(page.id, { limit: 100 }))
      .items;
    assert.deepEqual(
      deliveries.map((delivery) => delivery.contactId),
      [good.id],
    );
    assert.ok(
      (await tx.audit.list({ limit: 100 })).items.some(
        (event) => event.action === "paging.contact_skipped",
      ),
    );
  });
});
