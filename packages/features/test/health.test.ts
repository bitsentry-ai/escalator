import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  OperationalHealthCheck,
  evaluateHealth,
  defaultHealthPolicy,
  type QueueHealthSnapshot,
} from "../src/application/health/health.js";
const scope = workspaceIdSchema.parse("org_one");
const snapshot: QueueHealthSnapshot = {
  databaseNow: "2026-10-03T00:05:00.000Z",
  oldestDueJobAt: null,
  oldestDueOutboxAt: null,
  oldestDuePagingAt: null,
};
const progress = () => ({ running: true, laneAgeMs: [1000, 2000] });
test("readiness separates an idle but proven scheduler from unknown or stopped progress", () => {
  assert.equal(
    evaluateHealth(snapshot, progress(), defaultHealthPolicy).ready,
    true,
  );
  for (const value of [
    { running: false, laneAgeMs: [0] },
    { running: true, laneAgeMs: [] },
    { running: true, laneAgeMs: [null] },
    { running: true, laneAgeMs: [Number.NaN] },
  ]) {
    assert.deepEqual(
      evaluateHealth(snapshot, value, defaultHealthPolicy).reasons,
      ["scheduler_unavailable"],
    );
  }
  assert.deepEqual(
    evaluateHealth(
      snapshot,
      { running: true, laneAgeMs: [60001] },
      defaultHealthPolicy,
    ).reasons,
    ["scheduler_stalled"],
  );
});
test("overdue paging and outbox fail before the background job budget, including leased jobs", () => {
  const report = evaluateHealth(
    {
      ...snapshot,
      oldestDueJobAt: "2026-10-03T00:03:59.999Z",
      oldestDuePagingAt: "2026-10-03T00:03:59.999Z",
      oldestDueOutboxAt: "2026-10-03T00:03:59.999Z",
    },
    progress(),
    defaultHealthPolicy,
  );
  assert.equal(report.ready, false);
  assert.deepEqual(report.reasons, ["paging_overdue", "outbox_overdue"]);
  assert.equal(report.lagMs.paging, 60001);
  assert.equal(
    evaluateHealth(
      { ...snapshot, oldestDuePagingAt: "2026-10-03T00:04:00.000Z" },
      progress(),
      defaultHealthPolicy,
    ).ready,
    true,
  );
  assert.deepEqual(
    evaluateHealth(
      { ...snapshot, oldestDueJobAt: "2026-10-02T23:59:59.999Z" },
      progress(),
      defaultHealthPolicy,
    ).reasons,
    ["jobs_overdue"],
  );
});
test("health scope comes from construction and overlapping reads coalesce", async () => {
  let reads = 0;
  let resolve!: (value: QueueHealthSnapshot) => void;
  const checker = new OperationalHealthCheck(
    {
      async read(actual) {
        assert.equal(actual, scope);
        reads++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    scope,
    progress,
  );
  const a = checker.check(),
    b = checker.check();
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(reads, 1);
  resolve(snapshot);
  assert.equal((await a).ready, true);
  assert.equal((await b).ready, true);
});
test("database failures and malformed snapshots fail closed without exposing errors", async () => {
  for (const value of [
    new Error("private database host or query"),
    { ...snapshot, databaseNow: "invalid" },
    { ...snapshot, oldestDuePagingAt: "2026-10-03T00:06:00.000Z" },
  ]) {
    const checker = new OperationalHealthCheck(
      {
        async read() {
          if (value instanceof Error) throw value;
          return value;
        },
      },
      scope,
      progress,
    );
    const result = await checker.check();
    assert.deepEqual(result.reasons, ["database_unavailable"]);
    assert.equal(result.ready, false);
    assert.equal(result.databaseNow, null);
    assert.equal(result.lagMs.paging, null);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
test("a stranded database read times out, aborts, and cannot accumulate more queries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let querySignal: AbortSignal | undefined;
  let release!: (snapshot: QueueHealthSnapshot) => void;
  const checker = new OperationalHealthCheck(
    {
      async read(_scope, signal) {
        reads++;
        querySignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    scope,
    progress,
  );
  const result = checker.check();
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal((await result).ready, false);
  assert.equal(querySignal!.aborted, true);
  assert.equal((await checker.check()).ready, false);
  assert.equal(reads, 1);
  release(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
});
test("elapsed time protects readiness when a stalled event loop resumes before its timeout callback", async () => {
  let now = 0;
  const checker = new OperationalHealthCheck(
    {
      async read() {
        now = 5001;
        return snapshot;
      },
    },
    scope,
    progress,
    defaultHealthPolicy,
    () => now,
  );
  assert.deepEqual((await checker.check()).reasons, ["database_unavailable"]);
});
test("operational health rejects missing, excessive and nonintegral limits", () => {
  for (const policy of [
    { ...defaultHealthPolicy, queryTimeoutMs: 0 },
    { ...defaultHealthPolicy, maxPagingLagMs: 0.5 },
    { ...defaultHealthPolicy, maxJobLagMs: 3600001 },
    { ...defaultHealthPolicy, maxSchedulerAgeMs: Number.NaN },
  ])
    assert.throws(
      () =>
        new OperationalHealthCheck(
          {
            async read() {
              return snapshot;
            },
          },
          scope,
          progress,
          policy,
        ),
    );
});
