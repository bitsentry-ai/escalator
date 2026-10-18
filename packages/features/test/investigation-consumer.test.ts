import test from "node:test";
import assert from "node:assert/strict";
import { InvestigationConsumer } from "../src/investigation/orchestration/consumer.js";
import { investigationFixture } from "./fixtures/investigation.js";
import type { InvestigationRepository } from "../src/investigation/ports/index.js";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const sample = investigationFixture(),
    started = deferred(),
    release = deferred();
  const state = {
    claims: 0,
    executions: 0,
    publishes: 0,
    events: [] as string[],
  };
  const repository: Pick<
    InvestigationRepository,
    "claim" | "heartbeat" | "publish"
  > = {
    claim: async (input) => {
      state.claims++;
      return {
        ...sample.claim,
        id: `inv_${state.claims}`,
        runtimeId: input.runtimeId,
        claimToken: input.claimToken,
      };
    },
    heartbeat: async () => ({ leaseExpiresAt: "2026-10-01T01:05:00.000Z" }),
    publish: async () => {
      state.publishes++;
      return true;
    },
  };
  const consumer = new InvestigationConsumer(
    repository,
    async (claim, signal) => {
      state.executions++;
      started.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (signal.aborted) resolve();
        }),
      ]);
      const result = structuredClone(sample.result);
      result.report.id = claim.id;
      return result;
    },
    {
      workspaceId: sample.claim.scope.workspaceId,
      runtimeId: sample.claim.runtimeId,
      concurrency: 2,
      token: () => `token_${state.claims + 1}`,
    },
    (event) => state.events.push(event),
  );
  return { consumer, repository, state, started, release, sample };
}
test("overlapping polls respect reserved investigation capacity", async () => {
  const f = fixture();
  try {
    await Promise.all([
      f.consumer.tick(),
      f.consumer.tick(),
      f.consumer.tick(),
    ]);
    await f.started.promise;
    assert.equal(f.state.claims, 2);
    assert.equal(f.consumer.active, 2);
    await f.consumer.tick();
    assert.equal(f.state.claims, 2);
  } finally {
    await f.consumer.stop();
  }
  assert.equal(f.state.publishes, 0);
  assert.equal(f.consumer.active, 0);
});
test("shutdown leaves unfinished durable work reclaimable without publishing", async () => {
  const f = fixture();
  await f.consumer.tick();
  await f.started.promise;
  await f.consumer.stop();
  await f.consumer.tick();
  assert.equal(f.state.claims, 2);
  assert.equal(f.state.publishes, 0);
  assert.ok(f.state.events.every((e) => e === "cancelled"));
});
test("claim failures remain bounded to one attempt per tick", async () => {
  const f = fixture();
  f.repository.claim = async () => {
    f.state.claims++;
    throw new Error("private database detail");
  };
  await f.consumer.tick();
  assert.equal(f.state.claims, 1);
  assert.deepEqual(f.state.events, ["claim_failed"]);
  await f.consumer.tick();
  assert.equal(f.state.claims, 2);
  await f.consumer.stop();
});
test("an empty queue stops the tick rather than spending every slot", async () => {
  const f = fixture();
  f.repository.claim = async () => {
    f.state.claims++;
    return undefined;
  };
  await f.consumer.tick();
  assert.equal(f.state.claims, 1);
  assert.equal(f.state.executions, 0);
  await f.consumer.stop();
});
test("a claim returned after shutdown cannot start a model", async () => {
  const f = fixture(),
    pending = deferred();
  f.repository.claim = async () => {
    await pending.promise;
    return f.sample.claim;
  };
  const tick = f.consumer.tick(),
    stopped = f.consumer.stop();
  pending.resolve();
  await Promise.all([tick, stopped]);
  assert.equal(f.state.executions, 0);
  assert.equal(f.state.publishes, 0);
});
test("a misrouted runtime claim fails closed", async () => {
  const f = fixture();
  f.repository.claim = async () => ({ ...f.sample.claim, runtimeId: "other" });
  await f.consumer.tick();
  assert.equal(f.state.executions, 0);
  assert.deepEqual(f.state.events, ["claim_failed"]);
  await f.consumer.stop();
});

test("completed work publishes once and releases investigation slots", async () => {
  const f = fixture();
  f.release.resolve();
  await f.consumer.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.publishes, 2);
  assert.equal(f.consumer.active, 0);
  assert.deepEqual(f.state.events, ["published", "published"]);
  await f.consumer.stop();
});
