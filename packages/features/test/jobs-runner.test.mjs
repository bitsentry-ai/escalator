import test from "node:test";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  DurableWorkRunner,
  retryDelay,
  validateWorkResult,
} from "../dist/esm/application/index.js";
const options = {
  leaseMs: 5000,
  timeoutMs: 100,
  maxAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  token: () => "claim-token",
  random: () => 0.5,
};
const lease = {
  workspaceId: "org_fixture",
  queue: "outbox",
  id: "work_1",
  kind: "send",
  payload: {},
  token: "claim-token",
  attempt: 1,
  dueAt: "2026-09-19T00:00:00.000Z",
  leaseExpiresAt: "2026-09-19T00:00:05.000Z",
};
function fixture(handler, patch = {}, currentLease = lease) {
  const calls = [];
  const store = {
    claim: async (request) => {
      calls.push(["committed-claim", request]);
      return currentLease;
    },
    settle: async (claimed, result) => {
      calls.push(["settle", claimed, result]);
      return true;
    },
  };
  return {
    calls,
    store,
    runner: new DurableWorkRunner(
      store,
      { job: new Map(), outbox: new Map([["send", handler]]) },
      { ...options, ...patch },
    ),
  };
}
test("handler runs only after the claim returns and success settles its exact lease", async () => {
  const f = fixture(async (claimed) => {
    assert.equal(f.calls[0][0], "committed-claim");
    assert.equal(claimed, lease);
    return {
      state: "completed",
      outcome: "accepted",
      receipt: "provider-reference",
    };
  });
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "completed");
  assert.equal(f.calls[1][1], lease);
  assert.deepEqual(f.calls[0][1].kinds, ["send"]);
});
test("provider failure records uncertainty and bounded retry without persisting raw errors", async () => {
  const f = fixture(async () => {
    throw new Error("private-provider-error");
  });
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "retry");
  assert.deepEqual(f.calls[1][2], {
    state: "retry",
    delayMs: 750,
    outcome: "unknown",
  });
});
test("last allowed attempt fails without another retry", async () => {
  const f = fixture(
    async () => {
      throw new Error("failed");
    },
    {},
    { ...lease, attempt: 3 },
  );
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "failed");
  assert.deepEqual(f.calls[1][2], { state: "failed", outcome: "unknown" });
});
test("timeout aborts the attempt and late handler completion does not settle twice", async () => {
  let finish;
  let signal;
  const f = fixture(
    (_lease, attemptSignal) => {
      signal = attemptSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    { timeoutMs: 5 },
  );
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "retry");
  assert.equal(signal.aborted, true);
  finish({ state: "completed", outcome: "accepted" });
  await setImmediate();
  assert.equal(f.calls.filter(([name]) => name === "settle").length, 1);
});
test("stale settlement is reported and an empty queue never invokes a handler", async () => {
  const f = fixture(async () => ({ state: "completed", outcome: "accepted" }));
  f.store.settle = async () => false;
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "stale");
  f.store.claim = async () => undefined;
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "idle");
});
test("retry jitter stays bounded and invalid runner timing is rejected", () => {
  for (const attempt of [1, 2, 30, 100]) {
    const delay = retryDelay(attempt, options);
    assert.ok(delay > 0 && delay <= options.retryMaxMs);
  }
  assert.throws(
    () => fixture(async () => ({ state: "completed" }), { leaseMs: 100 }),
    /bounds/,
  );
});

test("a handler registered for the outbox cannot consume the job queue", async () => {
  const f = fixture(async () => ({ state: "completed", outcome: "accepted" }));
  assert.equal(await f.runner.runOne("org_fixture", "job"), "idle");
  assert.deepEqual(f.calls, []);
});

test("repeated process crashes exhaust the attempt budget before further I/O", async () => {
  let invoked = false;
  const f = fixture(
    async () => {
      invoked = true;
      return { state: "completed", outcome: "accepted" };
    },
    {},
    { ...lease, attempt: options.maxAttempts + 1 },
  );
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "failed");
  assert.equal(invoked, false);
  assert.deepEqual(f.calls[1][2], { state: "failed", outcome: "unknown" });
});

test("an outbox result without an outcome settles as unknown instead of redelivering the side effect", async () => {
  const f = fixture(async () => ({ state: "completed" }));
  f.store.settle = async (claimed, result) => {
    validateWorkResult(claimed, result);
    f.calls.push(["settle", claimed, result]);
    return true;
  };
  assert.equal(await f.runner.runOne("org_fixture", "outbox"), "completed");
  assert.deepEqual(f.calls[1][2], { state: "completed", outcome: "unknown" });
});
