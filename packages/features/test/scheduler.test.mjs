import test from "node:test";
import assert from "node:assert/strict";
import { DurableWorkScheduler } from "../dist/esm/application/index.js";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  "slow delivery does not block deadline work and shutdown drains both queues",
  { timeout: 3000 },
  async () => {
    const deliveryStarted = deferred();
    const releaseDelivery = deferred();
    const jobFinished = deferred();
    const claimed = new Set();
    let deliveryFinished = false;
    let errors = 0;
    const store = {
      async claim(input) {
        if (claimed.has(input.queue)) return undefined;
        claimed.add(input.queue);
        if (input.queue === "job") await deliveryStarted.promise;
        return {
          ...input,
          id: input.queue,
          kind: "fixture",
          payload: {},
          attempt: 1,
          dueAt: "2026-09-19T00:00:00.000Z",
          leaseExpiresAt: "2026-09-19T00:00:02.000Z",
        };
      },
      async settle(lease) {
        if (lease.queue === "job") jobFinished.resolve();
        return true;
      },
    };
    const scheduler = new DurableWorkScheduler(
      store,
      "org_fixture",
      {
        job: new Map([["fixture", async () => ({ state: "completed" })]]),
        outbox: new Map([
          [
            "fixture",
            async () => {
              deliveryStarted.resolve();
              await releaseDelivery.promise;
              deliveryFinished = true;
              return { state: "completed", outcome: "accepted" };
            },
          ],
        ]),
      },
      {
        leaseMs: 2000,
        timeoutMs: 1000,
        maxAttempts: 3,
        retryBaseMs: 100,
        retryMaxMs: 1000,
        token: () => "fixture_claim",
        random: () => 0.5,
      },
      {
        intervalMs: 1000,
        batchSize: 2,
        onError() {
          errors++;
        },
      },
    );
    scheduler.start();
    try {
      await jobFinished.promise;
      assert.equal(deliveryFinished, false);
      const stopping = scheduler.stop();
      assert.throws(() => scheduler.start(), /stopping/);
      releaseDelivery.resolve();
      await stopping;
      assert.equal(deliveryFinished, true);
      assert.equal(errors, 0);
    } finally {
      releaseDelivery.resolve();
      await scheduler.stop();
    }
  },
);
