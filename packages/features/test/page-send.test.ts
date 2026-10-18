import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PageDelivery } from "../src/application/paging/send.js";
import {
  PageAcknowledgements,
  acknowledgementDigest,
} from "../src/application/paging/acknowledge.js";
import { pagingWorkId } from "../src/application/paging/work-ids.js";
import type {
  NotificationChannel,
  ChannelNotification,
} from "../src/adapters/channels/ports.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
const signal = () => new AbortController().signal;
const tokenFrom = (n: ChannelNotification) =>
  new URLSearchParams(new URL(n.acknowledgementUrl).hash.slice(1)).get(
    "token",
  )!;
async function fixture(channel: "pushover" | "webhook" = "pushover") {
  let now = new Date("2026-09-20T00:00:00.000Z");
  const scope = workspaceIdSchema.parse("send-test");
  const repository = new MemoryPagingRepository({ now: () => now });
  await repository.transaction(scope, async (tx) => {
    await seedPagingFixture(tx);
    await tx.incidents.insert({
      ...(await tx.incidents.get("incident"))!,
      id: "send-incident",
    });
    await tx.pages.insert({
      ...(await tx.pages.get("page"))!,
      id: "send-page",
      incidentId: "send-incident",
    });
    await tx.steps.insert({
      ...(await tx.steps.get("step"))!,
      id: "send-step",
      pageId: "send-page",
    });
    await tx.deliveries.insert({
      ...(await tx.deliveries.get("delivery"))!,
      id: "send-delivery",
      pageId: "send-page",
      stepId: "send-step",
      channel,
    });
    const id = pagingWorkId(scope, "send", "send-delivery");
    await tx.work.enqueue("outbox", {
      id,
      kind: "paging.send",
      idempotencyKey: id,
      payload: {
        pageId: "send-page",
        deliveryId: "send-delivery",
        secretId: "secret",
        approvedSecretIds: ["secret"],
      },
      dueAt: tx.now,
    });
  });
  return {
    scope,
    repository,
    claim: async () =>
      (await repository.foundation.claim({
        workspaceId: scope,
        queue: "outbox",
        kinds: ["paging.send"],
        token: randomUUID(),
        leaseMs: 5000,
      }))!,
    attempts: () =>
      repository.transaction(
        scope,
        async (tx) =>
          (await tx.attempts.forDelivery("send-delivery", { limit: 100 }))
            .items,
      ),
    sender: (provider: NotificationChannel) =>
      new PageDelivery(
        repository,
        () => provider,
        "https://oncall.example/",
        86_400_000,
        () => 0.5,
      ),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
test("send commits a digest-only grant before I/O and persists the accepted receipt", async () => {
  const f = await fixture();
  const lease = await f.claim();
  let token = "";
  const sender = f.sender({
    send: async (n, use) => {
      token = tokenFrom(n);
      assert.equal(use.secretId, "secret");
      assert.equal(use.claimToken, lease.token);
      // A nested transaction would deadlock if provider I/O held the transaction lock.
      await f.repository.transaction(f.scope, async (tx) => {
        const grant = await tx.grants.findValid(acknowledgementDigest(token)!);
        assert.equal(grant?.pageId, "send-page");
        assert.equal(
          (await tx.attempts.get(grant!.attemptId))?.outcome,
          "in_flight",
        );
        assert.equal(JSON.stringify(grant).includes(token), false);
        assert.equal(
          JSON.stringify((await tx.work.lockClaim(lease))?.payload).includes(
            token,
          ),
          false,
        );
      });
      return { outcome: "accepted", receiptId: "receipt" };
    },
  });
  assert.deepEqual(await sender.send(lease, signal()), {
    state: "completed",
    outcome: "accepted",
    receipt: "receipt",
  });
  assert.equal((await f.attempts())[0]!.providerReceiptId, "receipt");
  assert.equal(
    (await new PageAcknowledgements(f.repository).preview(f.scope, token))
      .state,
    "open",
  );
  f.advance(5000);
  const poll = await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: ["paging.receipt"],
    token: randomUUID(),
    leaseMs: 5000,
  });
  assert.equal(poll?.payload.attemptId, (await f.attempts())[0]!.id);
  assert.deepEqual(poll?.payload.approvedSecretIds, ["secret"]);
});
test("duplicate active claims cannot send twice or settle the active provider attempt", async () => {
  const f = await fixture();
  const lease = await f.claim();
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sender = f.sender({
    send: async () => {
      calls++;
      started();
      await barrier;
      return { outcome: "accepted", receiptId: "receipt" };
    },
  });
  const first = sender.send(lease, signal());
  await entered;
  assert.deepEqual(await sender.send(lease, signal()), { state: "stale" });
  assert.equal(
    await f.repository.transaction(
      f.scope,
      async (tx) => !!(await tx.work.lockClaim(lease)),
    ),
    true,
  );
  release();
  await first;
  assert.equal(calls, 1);
});
test("an accepted attempt survives worker loss before outbox settlement without a resend", async () => {
  const f = await fixture();
  let calls = 0;
  const sender = f.sender({
    send: async () => {
      calls++;
      return { outcome: "accepted", receiptId: "receipt" };
    },
  });
  const first = await f.claim();
  await sender.send(first, signal());
  await f.repository.foundation.expireLease(first);
  assert.equal(
    (await sender.send(await f.claim(), signal())).state,
    "completed",
  );
  assert.equal(calls, 1);
  assert.equal((await f.attempts()).length, 1);
});
test("an ambiguous result is retained while a retry gets its own attempt and token", async () => {
  const f = await fixture("webhook");
  const tokens: string[] = [];
  const sender = f.sender({
    send: async (n) => {
      tokens.push(tokenFrom(n));
      return tokens.length === 1
        ? { outcome: "unknown", retryable: true }
        : { outcome: "accepted", receiptId: null };
    },
  });
  const first = await f.claim();
  const result = await sender.send(first, signal());
  assert.deepEqual(result, {
    state: "retry",
    delayMs: 3750,
    outcome: "unknown",
  });
  assert.notEqual(result.state, "stale");
  if (result.state !== "stale")
    await f.repository.foundation.settle(first, result);
  f.advance(5000);
  await sender.send(await f.claim(), signal());
  assert.notEqual(tokens[0], tokens[1]);
  assert.deepEqual((await f.attempts()).map((a) => a.outcome).sort(), [
    "accepted",
    "unknown",
  ]);
});
test("provider rejection distinguishes permanent configuration failures from throttling", async () => {
  for (const retryable of [false, true]) {
    const f = await fixture();
    const sender = f.sender({
      send: async () => ({
        outcome: "rejected",
        retryable,
        reason: "provider_rejected",
      }),
    });
    const result = await sender.send(await f.claim(), signal());
    assert.equal(result.state, retryable ? "retry" : "failed");
    assert.equal((await f.attempts())[0]!.failureReason, "provider_rejected");
  }
});
test("acknowledgement during I/O preserves late acceptance and enqueues a fresh cancellation", async () => {
  const f = await fixture();
  const lease = await f.claim();
  const sender = f.sender({
    send: async (n) => {
      assert.equal(
        (
          await new PageAcknowledgements(f.repository).acknowledge(
            f.scope,
            tokenFrom(n),
          )
        ).state,
        "acknowledged",
      );
      const cancel = await f.repository.foundation.claim({
        workspaceId: f.scope,
        queue: "job",
        kinds: ["paging.cancel"],
        token: randomUUID(),
        leaseMs: 5000,
      });
      assert.ok(cancel);
      await f.repository.foundation.settle(cancel, { state: "completed" });
      return { outcome: "accepted", receiptId: "late-receipt" };
    },
  });
  await sender.send(lease, signal());
  const attempt = (await f.attempts())[0]!;
  assert.equal(attempt.completedAfterAcknowledgement, true);
  assert.equal(attempt.providerReceiptId, "late-receipt");
  const cancel = await f.repository.foundation.claim({
    workspaceId: f.scope,
    queue: "job",
    kinds: ["paging.cancel"],
    token: randomUUID(),
    leaseMs: 5000,
  });
  assert.equal(cancel?.payload.attemptId, attempt.id);
  assert.equal(
    await f.repository.foundation.settle(lease, {
      state: "completed",
      outcome: "accepted",
    }),
    false,
  );
});
test("obsolete deadlines and stale leases cannot start provider I/O", async () => {
  for (const obsolete of [false, true]) {
    const f = await fixture();
    const lease = await f.claim();
    if (obsolete) f.advance(60000);
    else await f.repository.foundation.expireLease(lease);
    let calls = 0;
    const sender = f.sender({
      send: async () => {
        calls++;
        return { outcome: "accepted", receiptId: null };
      },
    });
    assert.deepEqual(await sender.send(lease, signal()), { state: "stale" });
    assert.equal(calls, 0);
    assert.equal((await f.attempts()).length, 0);
  }
});
test("untrusted provider receipt fields become unknown without persisting their contents", async () => {
  const f = await fixture();
  const sender = f.sender({
    send: async () => ({
      outcome: "accepted",
      receiptId: "sensitive\nresponse",
    }),
  });
  assert.equal((await sender.send(await f.claim(), signal())).state, "retry");
  assert.equal((await f.attempts())[0]!.providerReceiptId, null);
});
test("a recovered attempt keeps late evidence and cancels acceptance after its retry acknowledged", async () => {
  const f = await fixture();
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sender = f.sender({
    send: async (n) => {
      if (++calls === 1) {
        started();
        await barrier;
        return { outcome: "accepted", receiptId: "old-receipt" };
      }
      await new PageAcknowledgements(f.repository).acknowledge(
        f.scope,
        tokenFrom(n),
      );
      return { outcome: "accepted", receiptId: "new-receipt" };
    },
  });
  const firstLease = await f.claim();
  const first = sender.send(firstLease, signal());
  await entered;
  await f.repository.foundation.expireLease(firstLease);
  await sender.send(await f.claim(), signal());
  release();
  assert.deepEqual(await first, { state: "stale" });
  const attempts = await f.attempts();
  const old = attempts.find((a) => a.claimToken === firstLease.token)!;
  assert.equal(old.outcome, "unknown");
  await f.repository.transaction(f.scope, async (tx) => {
    const evidence = (await tx.audit.list({ limit: 100 })).items.find(
      (e) => e.action === "delivery.late_result",
    )!;
    assert.equal(evidence.metadata.receiptId, "old-receipt");
    assert.equal(evidence.metadata.afterAcknowledgement, true);
    const id = pagingWorkId(f.scope, "cancel-after", "send-delivery", old.id);
    assert.equal(
      await tx.work.enqueue("job", {
        id,
        kind: "paging.cancel",
        idempotencyKey: id,
        payload: {},
        dueAt: tx.now,
      }),
      "duplicate",
    );
  });
});
test("every accepted response is reconciled even when recovery already marked its attempt unknown", async () => {
  const f = await fixture();
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tokens: string[] = [];
  const sender = f.sender({
    send: async (n) => {
      tokens.push(tokenFrom(n));
      if (++calls === 1) {
        started();
        await barrier;
        return { outcome: "accepted", receiptId: "old-receipt" };
      }
      return { outcome: "accepted", receiptId: "new-receipt" };
    },
  });
  const firstLease = await f.claim();
  const first = sender.send(firstLease, signal());
  await entered;
  await f.repository.foundation.expireLease(firstLease);
  await sender.send(await f.claim(), signal());
  release();
  await first;
  f.advance(5000);
  const claim = () =>
    f.repository.foundation.claim({
      workspaceId: f.scope,
      queue: "job",
      kinds: ["paging.receipt"],
      token: randomUUID(),
      leaseMs: 5000,
    });
  const polls = [(await claim())!, (await claim())!];
  assert.deepEqual(polls.map((p) => p.payload.receiptId).sort(), [
    "new-receipt",
    "old-receipt",
  ]);
  assert.notEqual(polls[0]!.id, polls[1]!.id);
  await new PageAcknowledgements(f.repository).acknowledge(f.scope, tokens[0]!);
  for (const poll of polls)
    assert.equal(
      await f.repository.foundation.settle(poll, {
        state: "wait",
        delayMs: 5000,
      }),
      false,
    );
});
test("token-bearing acknowledgement links require HTTPS except on loopback", async () => {
  const { repository } = await fixture();
  const delivery = (url: string) =>
    new PageDelivery(repository, () => undefined, url);
  for (const url of [
    "http://oncall.example/",
    "http://10.0.0.5/",
    "http://localhost.example/",
    "ftp://oncall.example/",
  ])
    assert.throws(() => delivery(url), /Invalid acknowledgement/);
  for (const url of [
    "https://oncall.example/",
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://[::1]:8080/",
  ])
    assert.doesNotThrow(() => delivery(url));
});
