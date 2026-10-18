import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  scheduleSchema,
  configuredPolicySchema,
  serviceEnvironmentSchema,
  signalEventSchema,
  type SignalEvent,
} from "../src/contracts/index.js";
import {
  SignalProcessing,
  SignalRecovery,
  alertIdentity,
  resolvePageInTransaction,
  type DetectionRepository,
} from "../src/application/index.js";
import { MemoryDetectionRepository } from "./conformance/memory-detection.js";
import { seedDetectionFixture } from "./conformance/detection.js";
async function fixture(bind = true) {
  let now = Date.parse("2026-09-20T00:00:00.000Z");
  const scope = workspaceIdSchema.parse("detection-jobs");
  const repo = new MemoryDetectionRepository(() => new Date(now));
  const work = repo.configuration.paging.foundation;
  await repo.transaction(scope, async (tx) => {
    await seedDetectionFixture(tx);
    const schedule = scheduleSchema.parse({
      id: "primary",
      workspaceId: scope,
      serviceId: "api",
      name: "Primary",
      version: 1,
      enabled: true,
      rotations: [],
      overrides: [],
    });
    await tx.configuration.schedules.put(schedule, null);
    await tx.configuration.previews.insert({
      id: "preview",
      workspaceId: scope,
      scheduleId: schedule.id,
      serviceId: schedule.serviceId,
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
    const policy = configuredPolicySchema.parse({
      ...(await tx.pages.get("page"))!.policy,
      peerScheduleId: "primary",
      enabled: true,
      primaryPreviewId: "preview",
      peerPreviewId: "preview",
    });
    await tx.configuration.policies.put(policy, null);
    if (bind)
      await tx.detection.putBinding(
        serviceEnvironmentSchema.parse({
          id: "binding",
          workspaceId: scope,
          serviceId: "api",
          environmentId: "prod",
          version: 1,
          enabled: true,
          policyId: policy.id,
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
        null,
      );
  });
  const processing = new SignalProcessing(repo);
  const recovery = new SignalRecovery(repo);
  const claim = (kind = "signal.process") =>
    work.claim({
      workspaceId: scope,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: [kind],
    });
  async function event(
    id: string,
    status: "active" | "recovered",
    overrides: Partial<SignalEvent> = {},
  ) {
    await repo.transaction(scope, async (tx) => {
      const original = (await tx.signals.get("event"))!;
      await tx.signals.insert(
        signalEventSchema.parse({
          ...original,
          id,
          eventId: id,
          status,
          observedAt: new Date(now).toISOString(),
          receivedAt: tx.now,
          ...overrides,
        }),
      );
      await tx.work.enqueue("job", {
        id: `signal.process:${id}`,
        kind: "signal.process",
        idempotencyKey: `signal.process:${id}`,
        payload: { signalId: id },
        dueAt: tx.now,
      });
    });
    const lease = await claim();
    assert.ok(lease);
    return lease;
  }
  const process = async (
    id: string,
    status: "active" | "recovered",
    overrides: Partial<SignalEvent> = {},
  ) => {
    const lease = await event(id, status, overrides);
    const result = await processing.process(lease);
    assert.equal(await work.settle(lease, result), true);
    return lease;
  };
  const receipt = (id: string) =>
    repo.transaction(scope, (tx) => tx.detection.processed(id));
  const incident = async (id: string) =>
    repo.transaction(scope, async (tx) =>
      tx.incidents.get((await tx.detection.processed(id))!.incidentId!),
    );
  return {
    repo,
    scope,
    work,
    processing,
    recovery,
    claim,
    event,
    process,
    receipt,
    incident,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
test("processing crash before settlement replays the receipt without another page", async () => {
  const f = await fixture();
  const lease = await f.event("first", "active");
  await f.processing.process(lease);
  const receipt = await f.receipt("first");
  assert.ok(receipt?.incidentId);
  f.tick(30001);
  const reclaimed = await f.claim();
  assert.ok(reclaimed);
  await f.processing.process(reclaimed);
  assert.deepEqual(await f.receipt("first"), receipt);
  await f.repo.transaction(f.scope, async (tx) => {
    assert.equal((await tx.incidents.list({ limit: 100 })).items.length, 2); // fixture incident plus one generated incident
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (row) => row.action === "page.opened",
      ).length,
      1,
    );
  });
});
test("a failed audit rolls back the incident, alert, receipt and escalation jobs", async () => {
  const f = await fixture();
  const lease = await f.event("failure", "active");
  const broken: DetectionRepository = {
    transaction: (scope, run) =>
      f.repo.transaction(scope, (tx) =>
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
  };
  await assert.rejects(
    new SignalProcessing(broken).process(lease),
    /audit unavailable/,
  );
  assert.equal(await f.receipt("failure"), undefined);
  await f.repo.transaction(f.scope, async (tx) =>
    assert.equal((await tx.incidents.list({ limit: 100 })).items.length, 1),
  );
  assert.equal(await f.claim("paging.step"), undefined);
  await f.processing.process(lease);
  assert.ok((await f.receipt("failure"))?.incidentId);
});
test("an unbound signal completes with a durable audited disposition", async () => {
  const f = await fixture(false);
  const lease = await f.event("no-policy", "active");
  assert.equal((await f.processing.process(lease)).state, "completed");
  await f.processing.process(lease);
  assert.equal((await f.receipt("no-policy"))?.disposition, "unbound");
  await f.repo.transaction(f.scope, async (tx) => {
    assert.ok(
      (await tx.audit.list({ limit: 100 })).items.some(
        (event) =>
          event.subjectId === "no-policy" &&
          event.metadata.disposition === "unbound",
      ),
    );
    assert.equal((await tx.incidents.list({ limit: 100 })).items.length, 1);
  });
});
test("spoofed work hints and an expired lease cannot open a page", async () => {
  const f = await fixture();
  const lease = await f.event("valid", "active");
  await assert.rejects(
    f.processing.process({ ...lease, payload: { signalId: "event" } }),
    /Invalid signal processing claim/,
  );
  f.tick(30001);
  await f.processing.process(lease);
  assert.equal(await f.receipt("valid"), undefined);
});
test("recovery waits for its hold and repeated processing cannot resolve twice", async () => {
  const f = await fixture();
  await f.process("first", "active");
  f.tick(1000);
  await f.process("clear", "recovered");
  assert.equal(await f.claim("signal.recover"), undefined);
  f.tick(60000);
  const lease = await f.claim("signal.recover");
  assert.ok(lease);
  await f.recovery.recover(lease);
  await f.recovery.recover(lease);
  assert.ok((await f.incident("first"))?.resolvedAt);
  await f.repo.transaction(f.scope, async (tx) =>
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (row) => row.action === "incident.resolved",
      ).length,
      1,
    ),
  );
});
test("a relapse cancels an already claimed recovery job", async () => {
  const f = await fixture();
  await f.process("first", "active");
  f.tick(1000);
  await f.process("clear", "recovered");
  f.tick(60000);
  const recovery = await f.claim("signal.recover");
  assert.ok(recovery);
  await f.process("relapse", "active");
  await f.recovery.recover(recovery);
  assert.equal((await f.incident("first"))?.resolvedAt, null);
});
test("cross-source grouping waits for every contributor and its own hold", async () => {
  const f = await fixture();
  await f.repo.transaction(f.scope, async (tx) => {
    const source = (await tx.sources.get("source"))!;
    await tx.sources.replace(
      { ...source, version: 2, grouping: "fingerprint" },
      1,
    );
    await tx.sources.insert({
      ...source,
      id: "second",
      grouping: "fingerprint",
      recoveryHoldSeconds: 120,
    });
  });
  await f.process("first", "active");
  await f.process("other", "active", { sourceId: "second" });
  assert.equal(
    (await f.receipt("first"))?.incidentId,
    (await f.receipt("other"))?.incidentId,
  );
  f.tick(1000);
  await f.process("clear", "recovered");
  f.tick(60000);
  assert.equal(await f.claim("signal.recover"), undefined);
  await f.process("other-clear", "recovered", { sourceId: "second" });
  f.tick(60000);
  assert.equal(await f.claim("signal.recover"), undefined);
  f.tick(60000);
  const lease = await f.claim("signal.recover");
  assert.ok(lease);
  await f.recovery.recover(lease);
  assert.ok((await f.incident("first"))?.resolvedAt);
});
test("stale recovery cannot clear a newer active observation", async () => {
  const f = await fixture();
  await f.process("first", "active");
  f.tick(2000);
  await f.process("newer", "active");
  await f.process("old-clear", "recovered", {
    observedAt: "2026-09-20T00:00:01.000Z",
  });
  assert.equal((await f.receipt("old-clear"))?.disposition, "stale");
  f.tick(120000);
  assert.equal(await f.claim("signal.recover"), undefined);
});
test("manual resolution suppresses old queued alerts while a later recurrence opens a new incident", async () => {
  const f = await fixture();
  await f.process("first", "active");
  f.tick(1000);
  const first = (await f.receipt("first"))!.incidentId!;
  await f.repo.transaction(f.scope, (tx) =>
    resolvePageInTransaction(tx, first, {
      kind: "system",
      component: "operator",
    }),
  );
  await f.process("late", "active", { observedAt: "2026-09-20T00:00:00.500Z" });
  assert.equal((await f.receipt("late"))?.disposition, "manually_resolved");
  f.tick(1000);
  await f.process("recurrence", "active");
  assert.notEqual((await f.receipt("recurrence"))?.incidentId, first);
});
test("a relapse observed before automatic resolution but processed after it opens a new incident", async () => {
  const f = await fixture();
  await f.process("first", "active");
  const first = (await f.receipt("first"))!.incidentId!;
  f.tick(1000);
  await f.process("clear", "recovered");
  f.tick(60000);
  const recovery = await f.claim("signal.recover");
  assert.ok(recovery);
  await f.recovery.recover(recovery);
  assert.ok((await f.incident("first"))?.resolvedAt);
  await f.process("relapse", "active", {
    observedAt: "2026-09-20T00:00:30.000Z",
  });
  const relapse = await f.receipt("relapse");
  assert.equal(relapse?.disposition, "active");
  assert.ok(relapse?.incidentId);
  assert.notEqual(relapse.incidentId, first);
  await f.repo.transaction(f.scope, async (tx) =>
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (row) => row.action === "page.opened",
      ).length,
      2,
    ),
  );
});
test("an active group's incident link cannot be detached", async () => {
  const f = await fixture();
  await f.process("first", "active");
  await assert.rejects(
    f.repo.transaction(f.scope, async (tx) => {
      const signal = (await tx.signals.get("first"))!;
      const alert = (await tx.detection.alert(alertIdentity(signal)))!;
      const group = (await tx.detection.lockGroup(alert.groupKey))!;
      await tx.detection.putGroup(
        { ...group, incidentId: null, revision: group.revision + 1 },
        group.revision,
      );
    }),
    { code: "identity_change" },
  );
});
