import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import {
  MetricPollingJobs,
  scheduleMetric,
} from "../src/application/metrics/jobs.js";
import { DurableWorkRunner } from "../src/application/jobs/runner.js";
import { normalizeMetricCounts } from "../src/adapters/metrics/normalize.js";
import type { MetricsRepository } from "../src/application/metrics/ports.js";
import { MemoryMetricsRepository } from "./conformance/memory-metrics.js";
import { seedMetricFixture } from "./conformance/metrics.js";
async function fixture() {
  let now = Date.parse("2026-10-03T00:00:00.000Z"),
    calls = 0,
    errors = 10;
  const scope = workspaceIdSchema.parse("metric-jobs");
  const repository = new MemoryMetricsRepository(() => new Date(now));
  await repository.transaction(scope, async (tx) => {
    const monitor = await seedMetricFixture(tx);
    await scheduleMetric(tx, monitor, tx.now);
  });
  const work = repository.signals.foundation;
  let duringRead = async () => {};
  const reader = {
    read: async (
      ...args: Parameters<
        import("../src/adapters/metrics/reader.js").PrometheusMetricsReader["read"]
      >
    ) => {
      calls++;
      // A transaction here proves the job released the snapshot transaction before I/O.
      await repository.transaction(scope, async (tx) =>
        assert.ok(await tx.metrics.get("metric")),
      );
      await duringRead();
      const [config, range] = args;
      const body = (value: number) =>
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: {},
                values: [[Date.parse(range.startAt) / 1000, String(value)]],
              },
            ],
          },
        });
      return normalizeMetricCounts(config, range, body(100), body(errors));
    },
  };
  const jobs = new MetricPollingJobs(repository, reader);
  const claim = () =>
    work.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["metrics.poll"],
      token: randomUUID(),
      leaseMs: 30000,
    });
  const run = async () => {
    const lease = (await claim())!;
    assert.ok(lease);
    assert.equal(
      (await jobs.poll(lease, new AbortController().signal)).state,
      "completed",
    );
    await work.settle(lease, { state: "completed" });
    return lease;
  };
  const statuses = async () => {
    const values: string[] = [];
    for (;;) {
      const lease = await work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["signal.process"],
        token: randomUUID(),
        leaseMs: 30000,
      });
      if (!lease) break;
      await repository.transaction(scope, async (tx) => {
        values.push(
          (await tx.signals.get(String(lease.payload.signalId)))!.status,
        );
      });
      await work.settle(lease, { state: "completed" });
    }
    return values;
  };
  return {
    repository,
    scope,
    work,
    jobs,
    reader,
    claim,
    run,
    statuses,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    errors: (value: number) => {
      errors = value;
    },
    duringRead: (fn: () => Promise<void>) => {
      duringRead = fn;
    },
  };
}
test(
  "metric windows warm up without recovery, then emit active and explicit clear",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const first = await f.run();
    await f.repository.transaction(f.scope, async (tx) =>
      assert.equal(
        (await tx.metrics.observation(first.id))?.evaluation.state,
        "insufficient_data",
      ),
    );
    assert.deepEqual(await f.statuses(), []);
    f.advance(60000);
    await f.run();
    assert.deepEqual(await f.statuses(), ["active"]);
    f.advance(60000);
    await f.run();
    assert.deepEqual(await f.statuses(), []);
    f.errors(0);
    f.advance(60000);
    await f.run();
    assert.deepEqual(await f.statuses(), ["recovered"]);
    f.advance(60000);
    await f.run();
    assert.deepEqual(await f.statuses(), []);
    assert.equal(f.calls(), 5);
  },
);
test(
  "a committed metric receipt survives restart and missed slots do not burst replay",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const first = (await f.claim())!;
    assert.equal(
      (await f.jobs.poll(first, new AbortController().signal)).state,
      "completed",
    );
    // Crash after commit, before settlement: the replacement sees the receipt without another query.
    f.advance(31000);
    const retry = (await f.claim())!;
    assert.equal(retry.id, first.id);
    assert.notEqual(retry.token, first.token);
    assert.equal(
      (
        await new MetricPollingJobs(f.repository, f.reader).poll(
          retry,
          new AbortController().signal,
        )
      ).state,
      "completed",
    );
    assert.equal(f.calls(), 1);
    await f.work.settle(retry, { state: "completed" });
    f.advance(300000);
    await f.run();
    assert.equal(await f.claim(), undefined);
    assert.deepEqual(await f.statuses(), []);
    await f.repository.transaction(f.scope, async (tx) => {
      const events = (await tx.audit.list({ limit: 100 })).items.filter(
        (e) => e.action === "metric.observed",
      );
      assert.ok(events.some((e) => e.metadata.skippedSlots === 4));
    });
  },
);
test(
  "expired claims cannot commit measurements or schedule successors",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const first = (await f.claim())!;
    f.duringRead(async () => {
      f.advance(31000);
    });
    assert.equal(
      (await f.jobs.poll(first, new AbortController().signal)).state,
      "stale",
    );
    await f.repository.transaction(f.scope, async (tx) => {
      assert.equal(await tx.metrics.observation(first.id), undefined);
      assert.equal((await tx.metrics.schedule("metric"))?.jobId, first.id);
    });
    f.duringRead(async () => {});
    const replacement = (await f.claim())!;
    assert.equal(
      (await f.jobs.poll(replacement, new AbortController().signal)).state,
      "completed",
    );
    assert.equal(f.calls(), 2);
  },
);
test(
  "an administrator disabling during a query cancels the old result without recovery",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const first = (await f.claim())!;
    f.duringRead(async () => {
      await f.repository.transaction(f.scope, async (tx) => {
        const monitor = (await tx.metrics.lock("metric"))!;
        const disabled = {
          ...monitor,
          enabled: false,
          version: 2,
          updatedAt: tx.now,
        };
        assert.equal(await tx.metrics.put(disabled, 1), true);
        await scheduleMetric(tx, disabled, tx.now);
      });
    });
    assert.equal(
      (await f.jobs.poll(first, new AbortController().signal)).state,
      "stale",
    );
    await f.repository.transaction(f.scope, async (tx) => {
      assert.equal(await tx.metrics.observation(first.id), undefined);
      assert.equal((await tx.metrics.schedule("metric"))?.jobId, null);
    });
    assert.deepEqual(await f.statuses(), []);
  },
);
test(
  "provider failures record unknown and audit failures roll back the entire poll",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const first = (await f.claim())!;
    let fail = true;
    const repository: MetricsRepository = {
      transaction: (scope, run) =>
        f.repository.transaction(scope, (tx) =>
          run({
            ...tx,
            audit: {
              ...tx.audit,
              append: async (event) => {
                if (fail && event.action === "metric.observed")
                  throw new Error("audit down");
                return tx.audit.append(event);
              },
            },
          }),
        ),
    };
    const jobs = new MetricPollingJobs(repository, {
      read: async () => {
        throw new Error("private upstream detail");
      },
    });
    await assert.rejects(jobs.poll(first, new AbortController().signal), {
      message: "audit down",
    });
    await f.repository.transaction(f.scope, async (tx) => {
      assert.equal(await tx.metrics.observation(first.id), undefined);
      assert.equal((await tx.metrics.schedule("metric"))?.jobId, first.id);
    });
    fail = false;
    assert.equal(
      (await jobs.poll(first, new AbortController().signal)).state,
      "completed",
    );
    await f.repository.transaction(f.scope, async (tx) => {
      const record = (await tx.metrics.observation(first.id))!;
      assert.equal(record.reason, "provider_unavailable");
      assert.equal(record.evaluation.state, "insufficient_data");
      assert.equal(
        JSON.stringify(record).includes("private upstream detail"),
        false,
      );
    });
    assert.deepEqual(await f.statuses(), []);
  },
);
test(
  "a metric poll that fails on every attempt stays pending and resumes the chain",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    let broken = true;
    const jobs = new MetricPollingJobs(
      {
        transaction: (scope, run) =>
          broken
            ? Promise.reject(new Error("database unavailable"))
            : f.repository.transaction(scope, run),
      },
      f.reader,
    );
    const runner = new DurableWorkRunner(
      f.work,
      {
        job: new Map([
          ["metrics.poll", (lease, signal) => jobs.poll(lease, signal)],
        ]),
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
    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      outcomes.push(await runner.runOne(f.scope, "job"));
      f.advance(60000);
    }
    assert.deepEqual(outcomes, ["retry", "retry", "retry", "retry", "wait"]);
    broken = false;
    assert.equal(await runner.runOne(f.scope, "job"), "completed");
    assert.equal(f.calls(), 1);
    await f.repository.transaction(f.scope, async (tx) => {
      const schedule = await tx.metrics.schedule("metric");
      assert.ok(schedule?.lastObservationId);
      assert.ok(Date.parse(schedule.dueAt!) > Date.parse(tx.now));
    });
  },
);
