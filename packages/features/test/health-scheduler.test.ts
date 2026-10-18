import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { DurableWorkScheduler } from "../src/application/jobs/scheduler.js";
import type { DurableWorkStore } from "../src/application/jobs/ports.js";
import type { WorkHandler } from "../src/application/jobs/runner.js";
const options = {
  leaseMs: 30000,
  timeoutMs: 20000,
  maxAttempts: 5,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  token: () => "claim",
  random: () => 0.5,
};
const job = new Map<string, WorkHandler>([
  ["health.fixture", async () => ({ state: "completed" })],
]);
const scope = workspaceIdSchema.parse("org_health");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test("scheduler reports real poll completion and resets proof across lifecycle changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let claims = 0;
  const store: DurableWorkStore = {
    async claim() {
      claims++;
      return undefined;
    },
    async settle() {
      return true;
    },
  };
  const scheduler = new DurableWorkScheduler(
    store,
    scope,
    { job, outbox: job },
    options,
    { intervalMs: 5000, batchSize: 1, onError() {} },
  );
  assert.equal(scheduler.progress().running, false);
  scheduler.start();
  assert.deepEqual(scheduler.progress().laneAgeMs, [null, null]);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(claims, 2);
  assert.ok(scheduler.progress().laneAgeMs.every((age) => age !== null));
  scheduler.start();
  assert.ok(scheduler.progress().laneAgeMs.every((age) => age !== null));
  await scheduler.stop();
  assert.equal(scheduler.progress().running, false);
  scheduler.start();
  assert.deepEqual(scheduler.progress().laneAgeMs, [null, null]);
  await scheduler.stop();
});
test("an empty handler timer is not evidence of database or processing progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let claims = 0;
  const store: DurableWorkStore = {
    async claim() {
      claims++;
      return undefined;
    },
    async settle() {
      return true;
    },
  };
  const scheduler = new DurableWorkScheduler(
    store,
    scope,
    { job: new Map(), outbox: new Map() },
    options,
    { intervalMs: 5000, batchSize: 1, onError() {} },
  );
  scheduler.start();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(claims, 0);
  assert.deepEqual(scheduler.progress().laneAgeMs, [null, null]);
  await scheduler.stop();
});
test("a stalled database claim cannot refresh scheduler health through timer ticks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (value: undefined) => void;
  const store: DurableWorkStore = {
    claim: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async settle() {
      return true;
    },
  };
  const scheduler = new DurableWorkScheduler(
    store,
    scope,
    { job, outbox: new Map() },
    options,
    { intervalMs: 5000, batchSize: 1, onError() {} },
  );
  scheduler.start();
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.deepEqual(scheduler.progress().laneAgeMs, [null, null]);
  release(undefined);
  await flush();
  assert.notEqual(scheduler.progress().laneAgeMs[0], null);
  assert.equal(scheduler.progress().laneAgeMs[1], null);
  await scheduler.stop();
});
