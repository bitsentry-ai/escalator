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
