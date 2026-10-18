import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "../src/contracts/index.js";
import {
  ProbeExecutionJobs,
  scheduleProbe,
} from "../src/application/probes/execute.js";
import type { ProbeObservation } from "../src/application/probes/http-runner.js";
import { DurableWorkRunner } from "../src/application/jobs/runner.js";
import { MemoryProbeRepository } from "./conformance/memory-probes.js";
import { seedProbeFixture } from "./conformance/probes.js";
const failed: ProbeObservation = {
  outcome: "failed",
  reason: "timeout",
  statusCode: null,
  durationMs: 1000,
};
const healthy: ProbeObservation = {
  outcome: "healthy",
  reason: "assertions_passed",
  statusCode: 200,
  durationMs: 100,
};
async function fixture(run = async () => failed) {
  let now = Date.parse("2026-09-20T00:00:00.000Z");
  let requests = 0;
  const scope = workspaceIdSchema.parse("probe-jobs");
  const repository = new MemoryProbeRepository(() => new Date(now));
  const work = repository.signals.foundation;
  await repository.transaction(scope, async (tx) => {
    const probe = await seedProbeFixture(tx);
    await scheduleProbe(tx, probe, tx.now);
  });
  const jobs = new ProbeExecutionJobs(repository, {
    run: async () => {
      requests++;
      return run();
    },
  });
  const claim = () =>
    work.claim({
      workspaceId: scope,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: ["probe.execute"],
    });
  const execute = async () => {
    const lease = await claim();
    assert.ok(lease);
    const result = await jobs.execute(lease, new AbortController().signal);
    if (result.state !== "stale")
      assert.equal(await work.settle(lease, result), true);
    return lease;
  };
  return {
    repository,
    scope,
    work,
    jobs,
    claim,
    execute,
    requests: () => requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("probe execution commits observation, signal and one aligned successor", async () => {
  const f = await fixture();
  const lease = await f.execute();
  assert.equal(f.requests(), 1);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal((await tx.probes.result(lease.id))?.outcome, "failed");
    assert.equal((await tx.probes.state("probe"))?.active, true);
    assert.equal(
      (await tx.probes.schedule("probe"))?.dueAt,
      "2026-09-20T00:01:00.000Z",
    );
    assert.equal(
      (await tx.probes.results("probe", { limit: 100 })).items.length,
      1,
    );
  });
  const signal = await f.work.claim({
    workspaceId: f.scope,
    queue: "job",
    token: randomUUID(),
    leaseMs: 30000,
    kinds: ["signal.process"],
  });
  assert.ok(signal);
  await f.repository.transaction(f.scope, async (tx) => {
    const event = await tx.signals.get(String(signal.payload.signalId));
    assert.equal(event?.status, "active");
    assert.equal(event?.severity, "critical");
  });
  assert.equal(await f.claim(), undefined);
});
test("crash after receipt commit but before lease settlement does not repeat HTTP or enqueue another successor", async () => {
  const f = await fixture();
  const first = await f.claim();
  assert.ok(first);
  assert.equal(
    (await f.jobs.execute(first, new AbortController().signal)).state,
    "completed",
  );
  f.advance(31000);
  const retry = await f.claim();
  assert.ok(retry);
  assert.equal(retry.id, first.id);
  assert.equal(
    (await f.jobs.execute(retry, new AbortController().signal)).state,
    "completed",
  );
  assert.equal(f.requests(), 1);
  assert.equal(await f.work.settle(retry, { state: "completed" }), true);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.probes.results("probe", { limit: 100 })).items.length,
      1,
    );
    assert.equal(
      (await tx.probes.schedule("probe"))?.dueAt,
      "2026-09-20T00:01:00.000Z",
    );
  });
});
test("healthy observations recover only after the configured threshold", async () => {
  let observation = failed;
  const f = await fixture(async () => observation);
  await f.execute();
  observation = healthy;
  f.advance(60000);
  await f.execute();
  assert.equal(
    await f.repository.transaction(
      f.scope,
      async (tx) => (await tx.probes.state("probe"))?.active,
    ),
    true,
  );
  f.advance(60000);
  await f.execute();
  assert.equal(
    await f.repository.transaction(
      f.scope,
      async (tx) => (await tx.probes.state("probe"))?.active,
    ),
    false,
  );
});
test("a configuration disable during HTTP fences the result and cancels the old job", async () => {
  let release!: (value: ProbeObservation) => void;
  let started!: () => void;
  const pending = new Promise<ProbeObservation>((resolve) => {
    release = resolve;
  });
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async () => {
    started();
    return pending;
  });
  const lease = await f.claim();
  assert.ok(lease);
  const execution = f.jobs.execute(lease, new AbortController().signal);
  await called;
  await f.repository.transaction(f.scope, async (tx) => {
    const probe = (await tx.probes.lock("probe"))!;
    const disabled = {
      ...probe,
      enabled: false,
      version: 2,
      updatedAt: tx.now,
    };
    assert.equal(await tx.probes.put(disabled, 1), true);
    await scheduleProbe(tx, disabled, tx.now);
  });
  release(healthy);
  assert.equal((await execution).state, "stale");
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(await tx.probes.result(lease.id), undefined);
    assert.equal((await tx.probes.schedule("probe"))?.jobId, null);
    assert.equal(await tx.probes.state("probe"), undefined);
  });
});
test("expired claims and forged work identity cannot execute HTTP", async () => {
  const f = await fixture();
  const lease = await f.claim();
  assert.ok(lease);
  f.advance(30001);
  assert.equal(
    (await f.jobs.execute(lease, new AbortController().signal)).state,
    "stale",
  );
  assert.equal(f.requests(), 0);
  const valid = await f.claim();
  assert.ok(valid);
  await assert.rejects(
    f.jobs.execute(
      { ...valid, payload: { ...valid.payload, probeId: "missing" } },
      new AbortController().signal,
    ),
  );
  assert.equal(f.requests(), 0);
});
test("disabled sources produce unknown observations without losing the recurring schedule", async () => {
  const f = await fixture();
  await f.repository.transaction(f.scope, async (tx) => {
    const source = (await tx.sources.get("probe-source"))!;
    await tx.sources.replace(
      { ...source, version: 2, enabled: false, updatedAt: tx.now },
      1,
    );
  });
  const lease = await f.execute();
  assert.equal(f.requests(), 0);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal((await tx.probes.result(lease.id))?.outcome, "unknown");
    assert.equal(
      (await tx.probes.schedule("probe"))?.dueAt,
      "2026-09-20T00:01:00.000Z",
    );
  });
});
test("downtime skips overdue slots and records the gap instead of replaying writes", async () => {
  const f = await fixture();
  f.advance(195000);
  await f.execute();
  assert.equal(f.requests(), 1);
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.probes.schedule("probe"))?.dueAt,
      "2026-09-20T00:04:00.000Z",
    );
    const audit = (await tx.audit.list({ limit: 100 })).items.find(
      (event) => event.action === "probe.observed",
    );
    assert.equal(audit?.metadata.skippedSlots, 3);
  });
});

test("a failed final transaction preserves the claim but rolls back observation, state and successor", async () => {
  const f = await fixture();
  let fail = true;
  let calls = 0;
  const jobs = new ProbeExecutionJobs(
    {
      transaction: (scope, run) =>
        f.repository.transaction(scope, (tx) =>
          run({
            ...tx,
            audit: {
              ...tx.audit,
              append: async (event) => {
                if (fail && event.action === "probe.observed")
                  throw new Error("audit unavailable");
                await tx.audit.append(event);
              },
            },
          }),
        ),
    },
    {
      run: async () => {
        calls++;
        return failed;
      },
    },
  );
  const lease = await f.claim();
  assert.ok(lease);
  await assert.rejects(jobs.execute(lease, new AbortController().signal));
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(await tx.probes.result(lease.id), undefined);
    assert.equal(await tx.probes.state("probe"), undefined);
    assert.equal((await tx.probes.schedule("probe"))?.jobId, lease.id);
  });
  assert.equal(
    await f.work.claim({
      workspaceId: f.scope,
      queue: "job",
      token: randomUUID(),
      leaseMs: 30000,
      kinds: ["signal.process"],
    }),
    undefined,
  );
  fail = false;
  assert.equal(
    (await jobs.execute(lease, new AbortController().signal)).state,
    "completed",
  );
  assert.equal(calls, 2);
});

test("a probe link that fails on every attempt stays pending and resumes the chain", async () => {
  const f = await fixture();
  let broken = true;
  const jobs = new ProbeExecutionJobs(
    {
      transaction: (scope, run) =>
        broken
          ? Promise.reject(new Error("database unavailable"))
          : f.repository.transaction(scope, run),
    },
    { run: async () => failed },
  );
  const runner = new DurableWorkRunner(
    f.work,
    {
      job: new Map([
        ["probe.execute", (lease, signal) => jobs.execute(lease, signal)],
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
  await f.repository.transaction(f.scope, async (tx) => {
    assert.equal(
      (await tx.probes.results("probe", { limit: 100 })).items.length,
      1,
    );
    assert.equal(
      (await tx.probes.schedule("probe"))?.dueAt,
      "2026-09-20T00:06:00.000Z",
    );
  });
});
test("an existing probe can be disabled when its secret is unavailable but cannot be re-enabled", async () => {
  let available = true;
  const repository = new MemoryProbeRepository(undefined, () => available);
  const scope = workspaceIdSchema.parse("secret-disable");
  await repository.transaction(scope, async (tx) => {
    const probe = await seedProbeFixture(tx);
    assert.equal(
      await tx.probes.put(
        {
          ...probe,
          version: 2,
          updatedAt: tx.now,
          config: { ...probe.config, authSecretId: "fixture-secret" },
        },
        1,
      ),
      true,
    );
  });
  available = false;
  await repository.transaction(scope, async (tx) => {
    const probe = (await tx.probes.lock("probe"))!;
    assert.equal(
      await tx.probes.put(
        { ...probe, version: 3, enabled: false, updatedAt: tx.now },
        2,
      ),
      true,
    );
  });
  await assert.rejects(
    repository.transaction(scope, async (tx) => {
      const probe = (await tx.probes.lock("probe"))!;
      await tx.probes.put(
        { ...probe, version: 4, enabled: true, updatedAt: tx.now },
        3,
      );
    }),
  );
  assert.equal(
    await repository.transaction(
      scope,
      async (tx) => (await tx.probes.get("probe"))?.enabled,
    ),
    false,
  );
});
