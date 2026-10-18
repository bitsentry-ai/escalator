import test from "node:test";
import assert from "node:assert/strict";
import { DurableWorkScheduler } from "../dist/esm/application/index.js";
const options = {
  leaseMs: 20000,
  timeoutMs: 10000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 1000,
  token: () => "fixture",
  random: () => 0.5,
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  "slow receipt I/O cannot consume deadline or cancellation lanes",
  { timeout: 5000 },
  async () => {
    const started = deferred(),
      release = deferred(),
      deadline = deferred(),
      cancel = deferred();
    const claimed = new Set();
    let receiptFinished = false;
    const store = {
      async claim(input) {
        assert.equal(input.kinds.length, 1);
        const kind = input.kinds[0];
        if (claimed.has(kind)) return undefined;
        claimed.add(kind);
        if (kind !== "paging.receipt") await started.promise;
        return {
          ...input,
          id: kind,
          kind,
          payload: {},
          attempt: 1,
          dueAt: "2026-09-20T00:00:00.000Z",
          leaseExpiresAt: "2026-09-20T00:00:20.000Z",
        };
      },
      async settle(lease) {
        if (lease.kind === "paging.step") deadline.resolve();
        if (lease.kind === "paging.cancel") cancel.resolve();
        return true;
      },
    };
    const scheduler = new DurableWorkScheduler(
      store,
      "org_fixture",
      {
        job: new Map([
          ["paging.step", async () => ({ state: "completed" })],
          ["paging.cancel", async () => ({ state: "completed" })],
          [
            "paging.receipt",
            async () => {
              started.resolve();
              await release.promise;
              receiptFinished = true;
              return { state: "completed" };
            },
          ],
        ]),
        outbox: new Map(),
      },
      options,
      {
        intervalMs: 1000,
        batchSize: 2,
        onError: () => {},
        jobLanes: [["paging.step"], ["paging.receipt"], ["paging.cancel"]],
      },
    );
    scheduler.start();
    try {
      await Promise.all([deadline.promise, cancel.promise]);
      assert.equal(receiptFinished, false);
      const stopping = scheduler.stop();
      release.resolve();
      await stopping;
      assert.equal(receiptFinished, true);
    } finally {
      release.resolve();
      await scheduler.stop();
    }
  },
);
test("job lanes reject missing, duplicate and unregistered handlers", () => {
  for (const lanes of [[], [[]], [["step"], ["step"]], [["other"]]]) {
    assert.throws(
      () =>
        new DurableWorkScheduler(
          {},
          "org_fixture",
          {
            job: new Map([["step", async () => ({ state: "completed" })]]),
            outbox: new Map(),
          },
          options,
          {
            intervalMs: 1000,
            batchSize: 2,
            onError: () => {},
            jobLanes: lanes,
          },
        ),
      /partition/,
    );
  }
});

test(
  "probe concurrency stays bounded while a deadline has its own worker",
  { timeout: 5000 },
  async () => {
    const full = deferred(),
      release = deferred(),
      deadline = deferred();
    let probes = 0,
      active = 0,
      peak = 0,
      deadlineClaimed = false;
    const store = {
      async claim(input) {
        const kind = input.kinds[0];
        if (kind === "probe.execute") {
          if (probes >= 4) return undefined;
          probes++;
        } else {
          if (deadlineClaimed) return undefined;
          deadlineClaimed = true;
          await full.promise;
        }
        return {
          ...input,
          id: `${kind}:${probes}`,
          kind,
          payload: {},
          attempt: 1,
          dueAt: "2026-09-20T00:00:00.000Z",
          leaseExpiresAt: "2026-09-20T00:00:20.000Z",
        };
      },
      async settle(lease) {
        if (lease.kind === "paging.step") deadline.resolve();
        return true;
      },
    };
    const scheduler = new DurableWorkScheduler(
      store,
      "org_fixture",
      {
        job: new Map([
          [
            "probe.execute",
            async () => {
              active++;
              peak = Math.max(peak, active);
              if (active === 2) full.resolve();
              await release.promise;
              active--;
              return { state: "completed" };
            },
          ],
          ["paging.step", async () => ({ state: "completed" })],
        ]),
        outbox: new Map(),
      },
      options,
      {
        intervalMs: 1000,
        batchSize: 2,
        onError: () => {},
        jobLanes: [["probe.execute"], ["paging.step"]],
        jobConcurrency: { "probe.execute": 2 },
      },
    );
    scheduler.start();
    try {
      await deadline.promise;
      assert.equal(active, 2);
      assert.equal(peak, 2);
      const stopping = scheduler.stop();
      release.resolve();
      await stopping;
      assert.equal(peak, 2);
      assert.equal(active, 0);
    } finally {
      release.resolve();
      await scheduler.stop();
    }
  },
);
test("job concurrency rejects unknown kinds, mixed lanes and excessive allocations", () => {
  const job = new Map(
    ["a", "b", "c"].map((kind) => [kind, async () => ({ state: "completed" })]),
  );
  for (const [jobLanes, jobConcurrency] of [
    [[["a"], ["b"], ["c"]], { missing: 2 }],
    [[["a"], ["b"], ["c"]], { a: 0 }],
    [[["a"], ["b"], ["c"]], { a: 33 }],
    [[["a"], ["b"], ["c"]], { a: 1.5 }],
    [[["a", "b"], ["c"]], { a: 2 }],
    [[["a"], ["b"], ["c"]], { a: 32, b: 32, c: 1 }],
  ])
    assert.throws(
      () =>
        new DurableWorkScheduler(
          {},
          "org_fixture",
          { job, outbox: new Map() },
          options,
          {
            intervalMs: 1000,
            batchSize: 2,
            onError: () => {},
            jobLanes,
            jobConcurrency,
          },
        ),
    );
});

test("combined parallel concurrency names the settings that exceed the scheduler limit", () => {
  const handler = async () => ({ state: "completed" });
  const kinds = ["probe.execute", "metrics.poll", "a", "b"];
  assert.throws(
    () =>
      new DurableWorkScheduler(
        { claim: async () => undefined, settle: async () => true },
        "org_fixture",
        {
          job: new Map(kinds.map((kind) => [kind, handler])),
          outbox: new Map(),
        },
        options,
        {
          intervalMs: 1000,
          onError() {},
          jobLanes: [["probe.execute"], ["metrics.poll"], ["a"], ["b"]],
          jobConcurrency: { "probe.execute": 32, "metrics.poll": 32 },
        },
      ),
    /exceeds the scheduler limit: probe\.execute 32 \+ metrics\.poll 32 \+ 2 other job lanes need 66 workers, above 64; lower the probe or metric concurrency setting/,
  );
});
