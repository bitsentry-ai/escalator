import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { HeartbeatJobs } from "../src/application/probes/heartbeat-jobs.js";
import { DurableWorkRunner } from "../src/application/jobs/runner.js";
import { HeartbeatIntake } from "../src/application/probes/heartbeat-intake.js";
import { MemoryHeartbeatRepository } from "./conformance/memory-heartbeats.js";
import {
  seedHeartbeatFixture,
  heartbeatTestToken,
} from "./conformance/heartbeats.js";
async function fixture() {
  let now = Date.parse("2026-10-03T00:00:00.000Z");
  const scope = workspaceIdSchema.parse("heartbeat-jobs");
  const repository = new MemoryHeartbeatRepository(() => new Date(now));
  await repository.transaction(scope, seedHeartbeatFixture);
  const work = repository.signals.foundation;
  const jobs = new HeartbeatJobs(repository);
  const intake = new HeartbeatIntake(repository, (id) => id === scope);
  const claim = () =>
    work.claim({
      workspaceId: scope,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: ["heartbeat.deadline"],
    });
  const ping = (eventId: string) =>
    intake.accept("heartbeat", heartbeatTestToken, {
      version: 1,
      eventId,
      observedAt: new Date(now).toISOString(),
    });
  const statuses = async () => {
    const result: { status: string; observedAt: string }[] = [];
    for (;;) {
      const lease = await work.claim({
        workspaceId: scope,
        queue: "job",
        token: randomUUID(),
        leaseMs: 30000,
        kinds: ["signal.process"],
      });
      if (!lease) break;
      await repository.transaction(scope, async (tx) => {
        const event = (await tx.signals.get(String(lease.payload.signalId)))!;
        result.push({ status: event.status, observedAt: event.observedAt });
      });
      await work.settle(lease, { state: "completed" });
    }
    return result;
  };
  return {
    repository,
    scope,
    work,
    jobs,
    claim,
    ping,
    statuses,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("a ping cancels an already claimed obsolete miss atomically", async () => {
  const f = await fixture();
  f.advance(70001);
  const lease = (await f.claim())!;
  assert.ok(lease);
  await f.ping("late");
  assert.equal((await f.jobs.miss(lease)).state, "stale");
  assert.deepEqual(await f.statuses(), []);
  await f.repository.transaction(f.scope, async (tx) =>
    assert.equal((await tx.heartbeats.state("heartbeat"))?.generation, 2),
  );
});
test("miss receipt survives restart and a single later ping emits explicit recovery", async () => {
  const f = await fixture();
  f.advance(70001);
  const first = (await f.claim())!;
  assert.ok(first);
  assert.equal((await f.jobs.miss(first)).state, "completed");
  // Crash before lease settlement. A replacement claim sees the cleared deadline pointer.
  f.advance(30001);
  const retry = (await f.claim())!;
  assert.ok(retry);
  assert.equal(
    (await new HeartbeatJobs(f.repository).miss(retry)).state,
    "completed",
  );
  await f.work.settle(retry, { state: "completed" });
  await f.ping("recovered");
  const events = await f.statuses();
  assert.deepEqual(events.map((row) => row.status).sort(), [
    "active",
    "recovered",
  ]);
  assert.ok(
    Date.parse(events.find((row) => row.status === "recovered")!.observedAt) >
      Date.parse(events.find((row) => row.status === "active")!.observedAt),
  );
});
test("the exact deadline waits one millisecond so same-tick recovery cannot lose to an active timestamp", async () => {
  const f = await fixture();
  f.advance(70000);
  const lease = (await f.claim())!;
  assert.deepEqual(await f.jobs.miss(lease), { state: "wait", delayMs: 1 });
  await f.work.settle(lease, { state: "wait", delayMs: 1 });
  f.advance(1);
  const later = (await f.claim())!;
  assert.equal((await f.jobs.miss(later)).state, "completed");
  await f.work.settle(later, { state: "completed" });
  await f.ping("same-tick-recovery");
  const events = await f.statuses();
  assert.equal(events.length, 2);
  assert.equal(
    events.find((row) => row.status === "recovered")?.observedAt,
    "2026-10-03T00:01:10.001Z",
  );
});
test("old duplicate pings never extend liveness and expiry still rejects their replay", async () => {
  const f = await fixture();
  const first = await f.ping("first");
  f.advance(300001);
  const intake = new HeartbeatIntake(f.repository, () => true);
  const input = {
    version: 1 as const,
    eventId: "first",
    observedAt: "2026-10-03T00:00:00.000Z",
  };
  assert.deepEqual(
    await intake.accept("heartbeat", heartbeatTestToken, input),
    { ...first, state: "duplicate" },
  );
  await assert.rejects(
    intake.accept("heartbeat", heartbeatTestToken, {
      ...input,
      eventId: "stale-new-event",
    }),
    { code: "stale_ping" },
  );
  f.advance(3600000);
  await assert.rejects(intake.accept("heartbeat", heartbeatTestToken, input), {
    code: "invalid_token",
  });
});
test("a deadline that fails on every attempt stays pending and still reports the miss", async () => {
  const f = await fixture();
  let broken = true;
  const jobs = new HeartbeatJobs({
    findGrantContext: (hash) => f.repository.findGrantContext(hash),
    transaction: (scope, run) =>
      broken
        ? Promise.reject(new Error("database unavailable"))
        : f.repository.transaction(scope, run),
  });
  const runner = new DurableWorkRunner(
    f.work,
    {
      job: new Map([["heartbeat.deadline", (lease) => jobs.miss(lease)]]),
      outbox: new Map(),
    },
    {
      leaseMs: 30000,
      timeoutMs: 20000,
      maxAttempts: 5,
      retryBaseMs: 1000,
      retryMaxMs: 60000,
      token: randomUUID,
      random: () => 0.5,
    },
  );
  f.advance(70001);
  const outcomes = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    outcomes.push(await runner.runOne(f.scope, "job"));
    f.advance(60000);
  }
  assert.deepEqual(outcomes, ["retry", "retry", "retry", "retry", "wait"]);
  broken = false;
  assert.equal(await runner.runOne(f.scope, "job"), "completed");
  assert.deepEqual(
    (await f.statuses()).map((event) => event.status),
    ["active"],
  );
});
