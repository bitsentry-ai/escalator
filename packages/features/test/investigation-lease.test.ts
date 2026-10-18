import test from "node:test";
import assert from "node:assert/strict";
import {
  executeInvestigationClaim,
  defaultInvestigationLeaseOptions,
  type InvestigationExecution,
} from "../src/investigation/orchestration/lease-runner.js";
import type {
  InvestigationRepository,
  InvestigationRunResult,
} from "../src/investigation/ports/index.js";
import { investigationFixture } from "./fixtures/investigation.js";
const options = { leaseMs: 3000, heartbeatEveryMs: 10, operationTimeoutMs: 30 };
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function fixture() {
  const { claim, result } = investigationFixture();
  const controller = new AbortController();
  const state = { renewals: 0, executions: 0, publishes: 0 };
  const repository: Pick<InvestigationRepository, "heartbeat" | "publish"> = {
    heartbeat: async (received, leaseMs) => {
      state.renewals++;
      assert.equal(received.claimToken, claim.claimToken);
      assert.equal(leaseMs, options.leaseMs);
      return { leaseExpiresAt: "2026-10-01T01:02:00.000Z" };
    },
    publish: async (received, value) => {
      state.publishes++;
      assert.equal(received.id, claim.id);
      assert.deepEqual(value, result);
      return true;
    },
  };
  const execute: InvestigationExecution = async (received, signal) => {
    state.executions++;
    assert.equal(received.leaseExpiresAt, "2026-10-01T01:02:00.000Z");
    assert.equal(signal.aborted, false);
    return result;
  };
  return {
    claim,
    result,
    controller,
    state,
    repository,
    execute,
    run: (engine = execute) =>
      executeInvestigationClaim(
        claim,
        repository,
        engine,
        controller.signal,
        options,
      ),
  };
}
test("live claims renew before execution and publish exactly once", async () => {
  const f = fixture();
  const outcome = await f.run();
  assert.equal(outcome.state, "published");
  assert.deepEqual(outcome.result, f.result);
  assert.deepEqual(f.state, { renewals: 1, executions: 1, publishes: 1 });
  const before = f.state.renewals;
  await delay(30);
  assert.equal(f.state.renewals, before);
});
test("expired or malformed initial renewals cannot start model work", async () => {
  for (const value of [undefined, { leaseExpiresAt: "invalid" }]) {
    const f = fixture();
    f.repository.heartbeat = async () => value;
    const outcome = await f.run();
    assert.equal(outcome.state, "lease_lost");
    assert.equal(outcome.result, null);
    assert.equal(f.state.executions, 0);
    assert.equal(f.state.publishes, 0);
  }
});
test("pre-cancelled runtime shutdown leaves the job untouched and reclaimable", async () => {
  const f = fixture();
  f.controller.abort();
  assert.equal((await f.run()).state, "cancelled");
  assert.deepEqual(f.state, { renewals: 0, executions: 0, publishes: 0 });
});
test("heartbeats run while the engine waits and stop after publication", async () => {
  const f = fixture();
  const outcome = await f.run(async (claim, signal) => {
    await delay(45);
    return f.execute(claim, signal);
  });
  assert.equal(outcome.state, "published");
  assert.ok(f.state.renewals >= 2);
  const count = f.state.renewals;
  await delay(30);
  assert.equal(f.state.renewals, count);
});
test("lease loss aborts noncooperative execution and refuses publication", async () => {
  const f = fixture();
  const renew = f.repository.heartbeat;
  f.repository.heartbeat = async (claim, ms) =>
    f.state.renewals >= 1 ? undefined : renew(claim, ms);
  let aborted = false;
  const outcome = await f.run(async (_claim, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    return new Promise(() => {});
  });
  assert.equal(outcome.state, "lease_lost");
  assert.equal(outcome.result, null);
  assert.equal(aborted, true);
  assert.equal(f.state.publishes, 0);
});
test("hanging heartbeat calls cannot hold the engine forever", async () => {
  const f = fixture();
  const renew = f.repository.heartbeat;
  f.repository.heartbeat = (claim, ms) =>
    f.state.renewals >= 1 ? new Promise(() => {}) : renew(claim, ms);
  const started = performance.now();
  const outcome = await f.run(() => new Promise(() => {}));
  assert.equal(outcome.state, "lease_lost");
  assert.equal(f.state.publishes, 0);
  assert.ok(performance.now() - started < 2000);
});
test("runtime shutdown during execution does not persist terminal cancellation", async () => {
  const f = fixture();
  let aborted = false;
  const outcome = await f.run(async (_claim, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    f.controller.abort();
    return new Promise(() => {});
  });
  assert.equal(outcome.state, "cancelled");
  assert.equal(aborted, true);
  assert.equal(f.state.publishes, 0);
});
test("execution exceptions or out-of-scope results cannot be published", async () => {
  const f = fixture();
  const outcome = await f.run(async () => {
    throw new Error("do not disclose secret");
  });
  assert.equal(outcome.state, "execution_failed");
  assert.equal(outcome.result, null);
  assert.equal(f.state.publishes, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /disclose secret/);
  const g = fixture();
  g.result.report.id = "other";
  assert.equal((await g.run()).state, "execution_failed");
  assert.equal(g.state.publishes, 0);
});
test("a stale publication fence returns lease loss without retrying", async () => {
  const f = fixture();
  f.repository.publish = async () => {
    f.state.publishes++;
    return false;
  };
  assert.equal((await f.run()).state, "lease_lost");
  assert.equal(f.state.publishes, 1);
  assert.equal(f.state.executions, 1);
});
test("lost publication responses are explicitly uncertain and never automatically retried", async () => {
  for (const mode of ["throw", "hang"]) {
    const f = fixture();
    let committed = false;
    f.repository.publish = async () => {
      f.state.publishes++;
      committed = true;
      if (mode === "throw") throw new Error("transport secret");
      return new Promise(() => {});
    };
    const outcome = await f.run();
    assert.equal(outcome.state, "publication_unknown");
    assert.equal(committed, true);
    assert.equal(f.state.publishes, 1);
    assert.equal(f.state.executions, 1);
    assert.doesNotMatch(JSON.stringify(outcome), /transport secret/);
  }
});
test("partial engine results remain partial after a fenced publication", async () => {
  const f = fixture();
  Object.assign(f.result.report, {
    status: "partial",
    reason: "budget_exhausted",
  });
  const outcome = await f.run();
  assert.equal(outcome.state, "published");
  assert.equal(outcome.result?.report.status, "partial");
  assert.equal(outcome.result?.report.reason, "budget_exhausted");
});
test("claim and output snapshots cannot be changed by host ports after capture", async () => {
  const f = fixture();
  const renew = f.repository.heartbeat;
  f.repository.heartbeat = async (claim, ms) => {
    Object.assign(f.claim, { runtimeId: "changed" });
    Object.assign(claim, { runtimeId: "mutated-port-input" });
    return renew(claim, ms);
  };
  let published: InvestigationRunResult | null = null;
  f.repository.publish = async (claim, result) => {
    assert.equal(claim.runtimeId, "worker_a");
    published = result;
    f.result.report.summary = "changed-after-validation";
    return true;
  };
  const outcome = await f.run();
  assert.equal(outcome.state, "published");
  assert.ok(published);
  assert.notEqual(outcome.result?.report.summary, f.result.report.summary);
});
test("unsafe renewal settings are rejected before touching durable work", async () => {
  for (const invalid of [
    { ...options, heartbeatEveryMs: 3000 },
    { ...options, operationTimeoutMs: 2000 },
    { ...options, leaseMs: 0 },
    { ...options, heartbeatEveryMs: 0 },
    { ...options, extra: true },
  ]) {
    const f = fixture();
    await assert.rejects(
      executeInvestigationClaim(
        f.claim,
        f.repository,
        f.execute,
        f.controller.signal,
        invalid,
      ),
    );
    assert.deepEqual(f.state, { renewals: 0, executions: 0, publishes: 0 });
  }
  assert.equal(Object.isFrozen(defaultInvestigationLeaseOptions), true);
});
