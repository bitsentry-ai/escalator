import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema, workspaceSchema } from "../src/contracts/index.js";
import {
  enqueueWatchdog,
  WatchdogJobs,
  watchdogJobKind,
} from "../src/application/health/watchdog.js";
import type { WatchdogOutcome } from "../src/application/health/watchdog.js";
import type { SecretStore } from "../src/application/ports/secrets.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
async function fixture() {
  let now = Date.parse("2026-10-03T00:00:00.000Z"),
    calls = 0,
    secretReads = 0,
    ready = true;
  let duringSecret = async () => {};
  let failAfter = false,
    claims = 0;
  const scope = workspaceIdSchema.parse("org_watchdog");
  const repo = new MemoryFoundationRepository({ now: () => new Date(now) });
  await repo.transaction(scope, async (tx) =>
    tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Watchdog",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    ),
  );
  const config = { secretId: "watchdog-credential", intervalSeconds: 60 };
  const outcomes: WatchdogOutcome[] = [];
  const secret: SecretStore = {
    async withSecret(use, consume) {
      secretReads++;
      assert.equal(use.workspaceId, scope);
      assert.equal(use.secretId, config.secretId);
      assert.equal(use.queue, "job");
      await duringSecret();
      const result = await consume(
        Buffer.from(
          JSON.stringify({
            url: "https://watchdog.example/ping/private-token",
          }),
        ),
      );
      if (failAfter) throw new Error("private broker detail");
      return result;
    },
  };
  const health = {
    async check() {
      return {
        ready,
        reasons: [],
        databaseNow: new Date(now).toISOString(),
        schedulerMaxAgeMs: 0,
        lagMs: { jobs: null, outbox: null, paging: null },
      };
    },
  };
  const http = {
    async send() {
      calls++;
      // A transaction here proves no network call runs inside the preparation transaction.
      await repo.transaction(scope, async (tx) =>
        assert.ok(await tx.workspace.get()),
      );
      return { status: 200, body: "" };
    },
  };
  const jobs = new WatchdogJobs(
    repo,
    scope,
    config,
    health,
    secret,
    http,
    (outcome) => outcomes.push(outcome),
  );
  return {
    repo,
    scope,
    config,
    jobs,
    secret,
    http,
    health,
    outcomes,
    calls: () => calls,
    reads: () => secretReads,
    ready(value: boolean) {
      ready = value;
    },
    advance(ms: number) {
      now += ms;
    },
    duringSecret(callback: () => Promise<void>) {
      duringSecret = callback;
    },
    failAfter() {
      failAfter = true;
    },
    claim: () =>
      repo.claim({
        workspaceId: scope,
        queue: "job",
        kinds: [watchdogJobKind(scope, config)],
        token: `claim-${claims++}`,
        leaseMs: 120000,
      }),
  };
}
test("replicas deduplicate watchdog intent and only opaque credentials enter durable work", async () => {
  const f = await fixture();
  await Promise.all([
    enqueueWatchdog(f.repo, f.scope, f.config),
    enqueueWatchdog(f.repo, f.scope, f.config),
  ]);
  const lease = await f.claim();
  assert.ok(lease);
  assert.equal(await f.claim(), undefined);
  assert.deepEqual(lease.payload.secretIds, [f.config.secretId]);
  assert.equal(JSON.stringify(lease.payload).includes("private-token"), false);
  assert.deepEqual(await f.jobs.run(lease, new AbortController().signal), {
    state: "completed",
  });
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.outcomes, ["accepted"]);
});
test("failed readiness suppresses watchdog network even though the scheduling timer runs", async () => {
  const f = await fixture();
  f.ready(false);
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.outcomes, ["suppressed"]);
});
test("readiness is evaluated after broker access, not before potentially slow decryption", async () => {
  const f = await fixture();
  f.duringSecret(async () => f.ready(false));
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal(f.calls(), 0);
});
test("old interval and replaced configuration intents never ping", async () => {
  const f = await fixture();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  f.advance(60001);
  const lease = await f.claim();
  assert.ok(lease);
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal(f.reads(), 0);
  const replacement = new WatchdogJobs(
    f.repo,
    f.scope,
    { ...f.config, secretId: "replacement" },
    f.health,
    f.secret,
    f.http,
  );
  await assert.rejects(replacement.run(lease, new AbortController().signal));
  assert.equal(f.reads(), 0);
});
test("a cancelled or foreign claim cannot authorize a watchdog ping", async () => {
  const f = await fixture();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  await assert.rejects(
    f.jobs.run(
      { ...lease, workspaceId: workspaceIdSchema.parse("other") },
      new AbortController().signal,
    ),
  );
  await f.repo.transaction(f.scope, async (tx) =>
    tx.work.cancel("job", [lease.id]),
  );
  assert.deepEqual(await f.jobs.run(lease, new AbortController().signal), {
    state: "stale",
  });
  assert.equal(f.calls(), 0);
  assert.equal(f.reads(), 0);
});
test("expiry during secret access suppresses network and cannot settle the old claim", async () => {
  const f = await fixture();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  f.duringSecret(async () => f.advance(120001));
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal(f.calls(), 0);
  assert.equal(await f.repo.settle(lease, { state: "completed" }), false);
});
test("post-send broker uncertainty remains unknown without exposing its error", async () => {
  const f = await fixture();
  f.failAfter();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  await f.jobs.run(lease, new AbortController().signal);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.outcomes, ["unknown"]);
});
test("a future interval can recover after an earlier watchdog intent exhausted retries", async () => {
  const f = await fixture();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const first = await f.claim();
  assert.ok(first);
  await f.repo.settle(first, { state: "failed" });
  f.advance(60000);
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const next = await f.claim();
  assert.ok(next);
  assert.notEqual(first.id, next.id);
  await f.jobs.run(next, new AbortController().signal);
  assert.equal(f.calls(), 1);
});

test("rolling configurations claim only their own watchdog intents", async () => {
  const f = await fixture();
  const next = { ...f.config, secretId: "replacement" };
  await enqueueWatchdog(f.repo, f.scope, next);
  assert.equal(await f.claim(), undefined);
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const own = await f.claim();
  assert.ok(own);
  const other = await f.repo.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: [watchdogJobKind(f.scope, next)],
    token: "next-claim",
    leaseMs: 30000,
  });
  assert.ok(other);
  assert.notEqual(own.id, other.id);
  assert.notEqual(own.kind, other.kind);
  assert.deepEqual(f.jobs.lane, [own.kind]);
});

test("watchdog handler composition preserves host handlers and rejects duplicates", async () => {
  const { withWatchdogHandlers } =
    await import("../src/application/health/watchdog-handlers.js");
  const f = await fixture();
  const handlers = { job: new Map(), outbox: new Map() };
  const merged = withWatchdogHandlers(handlers, f.jobs);
  assert.equal(handlers.job.size, 0);
  assert.equal(merged.job.size, 1);
  assert.equal(merged.outbox, handlers.outbox);
  assert.throws(() => withWatchdogHandlers(merged, f.jobs));
});

test("an aborted watchdog attempt cannot read credentials or contact a provider", async () => {
  const f = await fixture();
  await enqueueWatchdog(f.repo, f.scope, f.config);
  const lease = await f.claim();
  assert.ok(lease);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.jobs.run(lease, controller.signal), {
    state: "stale",
  });
  assert.equal(f.reads(), 0);
  assert.equal(f.calls(), 0);
});
