import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PageDelivery } from "../src/application/paging/send.js";
import { PagingProviderJobs } from "../src/application/paging/provider-jobs.js";
import { PageAcknowledgements } from "../src/application/paging/acknowledge.js";
import { cancelDeliveryWork } from "../src/application/paging/cancel.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import type { ReceiptChannel } from "../src/adapters/channels/ports.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
const signal = () => new AbortController().signal;
async function fixture(terminal = false) {
  let now = new Date("2026-09-20T00:00:00.000Z");
  let token = "";
  const scope = workspaceIdSchema.parse("provider-jobs");
  const repository = new MemoryPagingRepository({ now: () => now });
  const dueAt = new Date(
    now.getTime() + (terminal ? 120_000 : 0),
  ).toISOString();
  await repository.transaction(scope, async (tx) => {
    await seedPagingFixture(tx);
    await tx.incidents.insert({
      ...(await tx.incidents.get("incident"))!,
      id: "new-incident",
    });
    await tx.pages.insert({
      ...(await tx.pages.get("page"))!,
      id: "new-page",
      incidentId: "new-incident",
    });
    await tx.steps.insert({
      ...(await tx.steps.get("step"))!,
      id: "new-step",
      pageId: "new-page",
      logicalStepId: terminal ? "terminal" : "initial",
      dueAt,
      recordedAt: dueAt,
    });
    await tx.deliveries.insert({
      ...(await tx.deliveries.get("delivery"))!,
      id: "new-delivery",
      pageId: "new-page",
      stepId: "new-step",
      secretId: "original-secret",
      createdAt: dueAt,
    });
    const id = pagingWorkId(scope, "send", "new-delivery");
    await tx.work.enqueue("outbox", {
      id,
      kind: "paging.send",
      idempotencyKey: id,
      payload: {
        pageId: "new-page",
        deliveryId: "new-delivery",
        secretId: "original-secret",
        approvedSecretIds: ["original-secret"],
      },
      dueAt,
    });
  });
  now = new Date(dueAt);
  if (terminal)
    await repository.transaction(scope, async (tx) => {
      const page = (await tx.pages.lock("new-page"))!;
      assert.equal(
        await tx.pages.replace(
          { ...page, state: "exhausted", revision: page.revision + 1 },
          page.revision,
        ),
        true,
      );
    });
  const channel: ReceiptChannel = {
    send: async (n) => {
      token = new URLSearchParams(
        new URL(n.acknowledgementUrl).hash.slice(1),
      ).get("token")!;
      return { outcome: "accepted", receiptId: "receipt" };
    },
    inspect: async () => ({ state: "pending" }),
    cancel: async () => "cancelled",
  };
  const send = (await repository.foundation.claim({
    workspaceId: scope,
    queue: "outbox",
    kinds: ["paging.send"],
    token: randomUUID(),
    leaseMs: 5000,
  }))!;
  const sent = await new PageDelivery(
    repository,
    () => channel,
    "https://oncall.example",
  ).send(send, signal());
  if (sent.state !== "stale") await repository.foundation.settle(send, sent);
  now = new Date(now.getTime() + 5000);
  return {
    scope,
    repository,
    channel,
    token,
    jobs: new PagingProviderJobs(repository, channel, () => 0.5),
    claim: async (kind = "paging.receipt") =>
      (await repository.foundation.claim({
        workspaceId: scope,
        queue: "job",
        kinds: [kind],
        token: randomUUID(),
        leaseMs: 5000,
      }))!,
    page: () =>
      repository.transaction(
        scope,
        async (tx) => (await tx.pages.get("new-page"))!,
      ),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
test("pending receipts reschedule without spending the consecutive failure budget", async () => {
  const f = await fixture();
  const lease = await f.claim();
  const result = await f.jobs.poll(lease, signal());
  assert.equal(result.state, "wait");
  await f.repository.foundation.settle(lease, result);
  assert.equal(await f.claim(), undefined);
  f.advance(5000);
  assert.equal((await f.claim()).attempt, 1);
  assert.equal((await f.page()).state, "open");
});
test("authenticated provider acknowledgement owns the page and cancels remaining work atomically", async () => {
  const f = await fixture();
  f.channel.inspect = async (id, use) => {
    assert.equal(id, "receipt");
    assert.equal(use.secretId, "original-secret");
    return {
      state: "acknowledged",
      acknowledgedAt: "2026-09-20T00:00:04.000Z",
    };
  };
  await f.jobs.poll(await f.claim(), signal());
  assert.equal((await f.page()).acknowledgedBy, "primary");
  const cancel = await f.claim("paging.cancel");
  assert.deepEqual(cancel.payload.approvedSecretIds, ["original-secret"]);
});
test("provider retry expiry stops receipt polling without acknowledging or resolving the page", async () => {
  const f = await fixture();
  f.channel.inspect = async () => ({ state: "expired" });
  const lease = await f.claim();
  assert.deepEqual(await f.jobs.poll(lease, signal()), { state: "completed" });
  assert.equal(
    await f.repository.foundation.settle(lease, { state: "completed" }),
    true,
  );
  f.advance(5000);
  assert.equal(await f.claim(), undefined);
  const page = await f.page();
  assert.equal(page.state, "open");
  assert.equal(page.acknowledgedBy, null);
});
test("uncertain receipt responses retry without manufacturing ownership", async () => {
  const f = await fixture();
  f.channel.inspect = async () => ({ state: "unknown" });
  assert.deepEqual(await f.jobs.poll(await f.claim(), signal()), {
    state: "retry",
    delayMs: 5000,
  });
  assert.equal((await f.page()).acknowledgedBy, null);
});
test("acknowledgement while polling makes the late receipt response stale", async () => {
  const f = await fixture();
  f.channel.inspect = async () => {
    await new PageAcknowledgements(f.repository).acknowledge(f.scope, f.token);
    return {
      state: "acknowledged",
      acknowledgedAt: "2026-09-20T00:00:04.000Z",
    };
  };
  assert.deepEqual(await f.jobs.poll(await f.claim(), signal()), {
    state: "stale",
  });
  const events = await f.repository.transaction(f.scope, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.equal(
    events.items.filter((e) => e.action === "page.acknowledged").length,
    1,
  );
});
test("revoked receipt claims cannot inspect a provider", async () => {
  const f = await fixture();
  const lease = await f.claim();
  await f.repository.foundation.expireLease(lease);
  f.channel.inspect = async () => {
    assert.fail("stale claim reached provider");
  };
  assert.deepEqual(await f.jobs.poll(lease, signal()), { state: "stale" });
});
test("cancellation uses the frozen credential and retries an uncertain response", async () => {
  const f = await fixture();
  await new PageAcknowledgements(f.repository).acknowledge(f.scope, f.token);
  f.channel.cancel = async (id, use) => {
    assert.equal(id, "new-delivery");
    assert.equal(use.secretId, "original-secret");
    return "unknown";
  };
  assert.deepEqual(
    await f.jobs.cancel(await f.claim("paging.cancel"), signal()),
    { state: "retry", delayMs: 5000 },
  );
});

test("a clock rewind cannot revive a superseded delivery before cancellation", async () => {
  const f = await fixture();
  f.advance(60_000);
  await f.repository.transaction(f.scope, async (tx) => {
    const step = (await tx.steps.get("new-step"))!;
    await tx.steps.insert({
      ...step,
      id: "later-step",
      logicalStepId: "reminder:1",
      dueAt: "2026-09-20T00:01:00.000Z",
      recordedAt: tx.now,
    });
    await cancelDeliveryWork(tx, [(await tx.deliveries.get("new-delivery"))!]);
  });
  const lease = await f.claim("paging.cancel");
  f.advance(-65_000);
  let calls = 0;
  f.channel.cancel = async () => {
    calls++;
    return "cancelled";
  };
  assert.deepEqual(await f.jobs.cancel(lease, signal()), {
    state: "completed",
  });
  assert.equal(calls, 1);
  assert.equal((await f.page()).state, "open");
});

test("absolute receipt expiry stops pending polling without resolving the page", async () => {
  const f = await fixture(true);
  f.advance(86_400_000);
  f.channel.inspect = async () => {
    assert.fail("expired polling deadline reached provider");
  };
  assert.deepEqual(await f.jobs.poll(await f.claim(), signal()), {
    state: "completed",
  });
  assert.equal((await f.page()).state, "exhausted");
});
test("caller-supplied receipt and secret fields cannot replace the persisted authority", async () => {
  const f = await fixture();
  const lease = await f.claim();
  f.channel.inspect = async (id, use) => {
    assert.equal(id, "receipt");
    assert.equal(use.secretId, "original-secret");
    return { state: "pending" };
  };
  const forged = {
    ...lease,
    payload: {
      ...lease.payload,
      receiptId: "foreign-receipt",
      secretId: "foreign-secret",
      approvedSecretIds: ["foreign-secret"],
    },
  };
  assert.equal((await f.jobs.poll(forged, signal())).state, "wait");
});
test("late accepted evidence can acknowledge without rewriting a recovered unknown attempt", async () => {
  const f = await fixture();
  await f.repository.foundation.settle(await f.claim(), { state: "completed" });
  await f.repository.transaction(f.scope, async (tx) => {
    const prior = (
      await tx.attempts.forDelivery("new-delivery", { limit: 100 })
    ).items[0]!;
    const attempt = {
      ...prior,
      id: "late-attempt",
      attempt: 2,
      claimToken: "late-claim",
      startedAt: tx.now,
      finishedAt: null,
      outcome: "in_flight" as const,
      providerReceiptId: null,
      completedAfterAcknowledgement: false,
      retryable: false,
      failureReason: null,
    };
    await tx.attempts.insert(attempt);
    await tx.attempts.finish({
      ...attempt,
      outcome: "unknown",
      finishedAt: tx.now,
      retryable: true,
    });
    await tx.audit.append({
      id: pagingWorkId(f.scope, "late-result", attempt.id),
      workspaceId: f.scope,
      actor: { kind: "system", component: "paging" },
      action: "delivery.late_result",
      subjectType: "delivery",
      subjectId: "new-delivery",
      recordedAt: tx.now,
      metadata: {
        attemptId: attempt.id,
        outcome: "accepted",
        receiptId: "late-receipt",
        afterAcknowledgement: false,
      },
    });
    const id = pagingWorkId(f.scope, "receipt", "new-delivery", attempt.id);
    await tx.work.enqueue("job", {
      id,
      kind: "paging.receipt",
      idempotencyKey: id,
      dueAt: tx.now,
      payload: {
        pageId: "new-page",
        deliveryId: "new-delivery",
        attemptId: attempt.id,
        secretId: "original-secret",
        approvedSecretIds: ["original-secret"],
        receiptId: "late-receipt",
        pollUntil: new Date(Date.parse(tx.now) + 60_000).toISOString(),
      },
    });
  });
  f.channel.inspect = async (id) => {
    assert.equal(id, "late-receipt");
    return {
      state: "acknowledged",
      acknowledgedAt: "2026-09-20T00:00:05.000Z",
    };
  };
  await f.jobs.poll(await f.claim(), signal());
  assert.equal((await f.page()).acknowledgedBy, "primary");
  assert.equal(
    await f.repository.transaction(
      f.scope,
      async (tx) => (await tx.attempts.get("late-attempt"))!.outcome,
    ),
    "unknown",
  );
});
test("a superseded notification can still acknowledge during its valid grant window", async () => {
  const f = await fixture();
  f.advance(60_000);
  await f.repository.transaction(f.scope, async (tx) => {
    await cancelDeliveryWork(
      tx,
      [(await tx.deliveries.get("new-delivery"))!],
      false,
    );
  });
  const cancelled = await f.jobs.cancel(
    await f.claim("paging.cancel"),
    signal(),
  );
  assert.equal(cancelled.state, "completed");
  f.channel.inspect = async () => ({
    state: "acknowledged",
    acknowledgedAt: "2026-09-20T00:01:04.000Z",
  });
  await f.jobs.poll(await f.claim(), signal());
  assert.equal((await f.page()).acknowledgedBy, "primary");
});
test("receipt ownership cannot change after its grant window expires during I/O", async () => {
  const f = await fixture(true);
  f.advance(86_394_000);
  f.channel.inspect = async () => {
    f.advance(2000);
    return {
      state: "acknowledged",
      acknowledgedAt: "2026-09-21T00:01:59.000Z",
    };
  };
  assert.deepEqual(await f.jobs.poll(await f.claim(), signal()), {
    state: "completed",
  });
  assert.equal((await f.page()).acknowledgedBy, null);
});
