import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
import { HeartbeatManagement } from "../src/application/probes/heartbeat-management.js";
import {
  HeartbeatIntake,
  heartbeatTokenHash,
} from "../src/application/probes/heartbeat-intake.js";
import { HeartbeatJobs } from "../src/application/probes/heartbeat-jobs.js";
import { MemoryHeartbeatRepository } from "./conformance/memory-heartbeats.js";
import { seedSignalFixture } from "./conformance/signals.js";
const input = {
  name: "Cron",
  serviceId: "service",
  environmentId: "production",
};
async function fixture() {
  let now = Date.parse("2026-10-03T00:00:00.000Z");
  const repository = new MemoryHeartbeatRepository(() => new Date(now));
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("heartbeat-admin"),
    responderId: responderIdSchema.parse("admin"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  return {
    repository,
    actor,
    management: new HeartbeatManagement(repository, randomUUID),
    advance: (ms: number) => {
      now += ms;
    },
    time: () => new Date(now).toISOString(),
  };
}
test("heartbeat management creates disabled sources and atomically updates versioned deadlines", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, input);
  assert.equal(probe.enabled, false);
  assert.equal(
    (await f.management.get(f.actor, { id: probe.id })).state?.deadlineAt,
    null,
  );
  const updated = await f.management.update(f.actor, {
    id: probe.id,
    expectedVersion: 1,
    name: "Active cron",
    enabled: true,
    intervalSeconds: 120,
    graceSeconds: 5,
  });
  assert.equal(updated.version, 2);
  await assert.rejects(
    f.management.disable(f.actor, { id: probe.id, expectedVersion: 1 }),
    { message: "conflict" },
  );
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    assert.equal((await tx.sources.get(probe.sourceId))?.enabled, true);
    assert.equal(
      (await tx.heartbeats.state(probe.id))?.deadlineAt,
      "2026-10-03T00:02:05.000Z",
    );
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 2);
  });
});
test("heartbeat grants return secrets once, enforce expiry, and revoke without exposing tokens in audits", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, { ...input, enabled: true });
  await assert.rejects(
    f.management.issueGrant(f.actor, { id: probe.id, expiresAt: f.time() }),
    { message: "invalid_expiry" },
  );
  const grant = await f.management.issueGrant(f.actor, {
    id: probe.id,
    expiresAt: "2026-10-04T00:00:00.000Z",
  });
  assert.match(grant.token, /^ehb_[A-Za-z0-9_-]{43}$/);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const stored = await tx.heartbeats.grantByHash(
      heartbeatTokenHash(grant.token),
    );
    assert.equal(stored?.id, grant.id);
    const audit = JSON.stringify((await tx.audit.list({ limit: 100 })).items);
    assert.equal(audit.includes(grant.token), false);
    assert.equal(audit.includes(heartbeatTokenHash(grant.token)), false);
  });
  const listed = await f.management.grants(f.actor, { id: probe.id, limit: 1 });
  assert.equal(listed.items[0].id, grant.id);
  assert.equal(
    JSON.stringify(listed).includes(heartbeatTokenHash(grant.token)),
    false,
  );
  assert.equal(JSON.stringify(listed).includes(grant.token), false);
  await assert.rejects(
    f.management.grants({ ...f.actor, role: "viewer" }, { id: probe.id }),
    { message: "forbidden" },
  );
  await assert.rejects(
    f.management.grants(
      { ...f.actor, workspaceId: workspaceIdSchema.parse("another") },
      { id: probe.id },
    ),
    { message: "not_found" },
  );
  await f.management.revokeGrant(f.actor, { id: probe.id, grantId: grant.id });
  assert.equal(
    (await f.management.grants(f.actor, { id: probe.id })).items[0].revokedAt,
    f.time(),
  );
  await assert.rejects(
    new HeartbeatIntake(f.repository, () => true).accept(
      probe.id,
      grant.token,
      { version: 1, eventId: "ping", observedAt: f.time() },
    ),
    { message: "invalid_token" },
  );
});
test("disabling an overdue heartbeat cancels its intent without claiming recovery", async () => {
  const f = await fixture();
  const probe = await f.management.create(f.actor, { ...input, enabled: true });
  f.advance(70001);
  const lease = await f.repository.signals.foundation.claim({
    workspaceId: f.actor.workspaceId,
    queue: "job",
    token: randomUUID(),
    leaseMs: 30000,
    kinds: ["heartbeat.deadline"],
  });
  assert.ok(lease);
  await new HeartbeatJobs(f.repository).miss(lease);
  const before = (await f.management.get(f.actor, { id: probe.id })).state!;
  assert.ok(before.missedAt);
  await f.management.disable(f.actor, { id: probe.id, expectedVersion: 1 });
  const after = (await f.management.get(f.actor, { id: probe.id })).state!;
  assert.equal(after.missedAt, before.missedAt);
  assert.equal(after.deadlineJobId, null);
});
test("heartbeat management rejects non-admin writes and tenant injection", async () => {
  const f = await fixture();
  await assert.rejects(
    f.management.create({ ...f.actor, role: "viewer" }, input),
    { message: "forbidden" },
  );
  await assert.rejects(
    f.management.create(f.actor, {
      ...input,
      workspaceId: "other",
    } as typeof input),
  );
  assert.equal((await f.management.list(f.actor)).items.length, 0);
});
