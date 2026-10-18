import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WorkPoller } from "../dist/esm/application/index.js";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  "stopping drains the current attempt without overlapping or claiming another item",
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const finish = deferred();
    let calls = 0;
    const poller = new WorkPoller(
      async () => {
        calls++;
        entered.resolve();
        await finish.promise;
        return "completed";
      },
      { intervalMs: 1, batchSize: 10, onError() {} },
    );
    poller.start();
    poller.start();
    await entered.promise;
    const stop = poller.stop();
    assert.throws(() => poller.start(), /stopping/);
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await delay(10);
    assert.equal(stopped, false);
    assert.equal(calls, 1);
    finish.resolve();
    await stop;
    await delay(10);
    assert.equal(calls, 1);
  },
);
test(
  "poller retries after an adapter failure, even when its error reporter throws",
  { timeout: 3000 },
  async () => {
    const recovered = deferred();
    let attempts = 0;
    let errors = 0;
    const poller = new WorkPoller(
      async () => {
        if (++attempts === 1) throw new Error("database unavailable");
        recovered.resolve();
        return "idle";
      },
      {
        intervalMs: 1,
        batchSize: 2,
        onError() {
          errors++;
          throw new Error("logger unavailable");
        },
      },
    );
    poller.start();
    await recovered.promise;
    await poller.stop();
    assert.equal(errors, 1);
    assert.equal(attempts, 2);
  },
);
test(
  "an idle queue waits for the next poll instead of draining its batch",
  { timeout: 3000 },
  async () => {
    const polled = deferred();
    let calls = 0;
    const poller = new WorkPoller(
      async () => {
        calls++;
        polled.resolve();
        return "idle";
      },
      { intervalMs: 60_000, batchSize: 100, onError() {} },
    );
    poller.start();
    await polled.promise;
    await poller.stop();
    assert.equal(calls, 1);
  },
);

test(
  "shutdown requested by an attempt still waits for that attempt",
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const finish = deferred();
    let stopped = false;
    const poller = new WorkPoller(
      async () => {
        void poller.stop().then(() => {
          stopped = true;
        });
        entered.resolve();
        await finish.promise;
        return "completed";
      },
      { intervalMs: 1, batchSize: 1, onError() {} },
    );
    poller.start();
    await entered.promise;
    await delay(10);
    assert.equal(stopped, false);
    finish.resolve();
    await poller.stop();
    assert.equal(stopped, true);
  },
);
