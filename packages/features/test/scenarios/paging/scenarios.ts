import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  PageDelivery,
  PagingProviderJobs,
  PageAcknowledgements,
  PageAdvancement,
  pagingWorkId,
  type PagingRepository,
  type DurableWorkStore,
  type DispatchRepository,
} from "@bitsentry-escalator/features/application";
import type {
  NotificationChannel,
  ReceiptChannel,
} from "@bitsentry-escalator/features/channels";
import { seedPagingFixture } from "../../conformance/paging.js";
export interface FailureFixture {
  repository: PagingRepository;
  work: DurableWorkStore;
  /** New host repository instance over the same committed database. */
  reopen(): PagingRepository;
  dispose(): Promise<void>;
}
export function pagingFailureScenarios(
  name: string,
  create: () => Promise<FailureFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((name, run) => test(name, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (fixture: FailureFixture, scope: WorkspaceId) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const scope = workspaceIdSchema.parse(`failure_${randomUUID()}`);
      try {
        await fixture.repository.transaction(scope, seedPagingFixture);
        await run(fixture, scope);
      } finally {
        await fixture.dispose();
      }
    });
  async function queued(f: FailureFixture, scope: WorkspaceId) {
    await f.repository.transaction(scope, async (tx) => {
      await tx.incidents.insert({
        ...(await tx.incidents.get("incident"))!,
        id: "queued-incident",
      });
      await tx.pages.insert({
        ...(await tx.pages.get("page"))!,
        id: "queued-page",
        incidentId: "queued-incident",
      });
      await tx.steps.insert({
        ...(await tx.steps.get("step"))!,
        id: "queued-step",
        pageId: "queued-page",
      });
      await tx.deliveries.insert({
        ...(await tx.deliveries.get("delivery"))!,
        id: "queued-delivery",
        pageId: "queued-page",
        stepId: "queued-step",
      });
      const id = pagingWorkId(scope, "send", "queued-delivery");
      await tx.work.enqueue("outbox", {
        id,
        kind: "paging.send",
        idempotencyKey: id,
        dueAt: tx.now,
        payload: {
          pageId: "queued-page",
          deliveryId: "queued-delivery",
          secretId: "secret",
          approvedSecretIds: ["secret"],
        },
      });
    });
    const lease = await f.work.claim({
      workspaceId: scope,
      queue: "outbox",
      kinds: ["paging.send"],
      token: randomUUID(),
      leaseMs: 60_000,
    });
    assert.ok(lease);
    return lease;
  }
  const sender = (repo: PagingRepository, channel: NotificationChannel) =>
    new PageDelivery(
      repo,
      () => channel,
      "https://oncall.example",
      86_400_000,
      () => 0.5,
    );
  scenario(
    "restart consumes committed outbox once and retains the provider receipt",
    async (f, scope) => {
      const lease = await queued(f, scope);
      const reopened = f.reopen();
      let calls = 0;
      const channel: NotificationChannel = {
        send: async () => {
          calls++;
          return { outcome: "accepted", receiptId: "restart-receipt" };
        },
      };
      const result = await sender(reopened, channel).send(
        lease,
        new AbortController().signal,
      );
      assert.notEqual(result.state, "stale");
      if (result.state !== "stale")
        assert.equal(await f.work.settle(lease, result), true);
      await sender(f.reopen(), channel).send(
        lease,
        new AbortController().signal,
      );
      assert.equal(calls, 1);
      await f.reopen().transaction(scope, async (tx) => {
        const rows = (
          await tx.attempts.forDelivery("queued-delivery", { limit: 10 })
        ).items;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.outcome, "accepted");
        assert.equal(rows[0]?.providerReceiptId, "restart-receipt");
        assert.equal((await tx.pages.get("queued-page"))?.state, "open");
      });
    },
  );
  scenario(
    "duplicate acknowledgement after restart keeps the first owner and timestamp",
    async (f, scope) => {
      const lease = await queued(f, scope);
      let token = "";
      await sender(f.repository, {
        send: async (n) => {
          token = new URLSearchParams(
            new URL(n.acknowledgementUrl).hash.slice(1),
          ).get("token")!;
          return { outcome: "accepted", receiptId: "ack-receipt" };
        },
      }).send(lease, new AbortController().signal);
      await new PageAcknowledgements(f.repository).acknowledge(scope, token);
      const first = await f.repository.transaction(scope, (tx) =>
        tx.pages.get("queued-page"),
      );
      await new PageAcknowledgements(f.reopen()).acknowledge(scope, token);
      await f.reopen().transaction(scope, async (tx) => {
        const page = await tx.pages.get("queued-page");
        assert.equal(page?.state, "acknowledged");
        assert.equal(page?.acknowledgedBy, "primary");
        assert.equal(page?.acknowledgedAt, first?.acknowledgedAt);
        assert.equal(page?.revision, first?.revision);
        assert.equal(await tx.work.lockClaim(lease), undefined);
      });
    },
  );
  scenario(
    "duplicate provider receipt work preserves first ownership after restart",
    async (f, scope) => {
      let acknowledgedAt = "";
      await f.repository.transaction(scope, async (tx) => {
        acknowledgedAt = tx.now;
        const attempt = (await tx.attempts.get("attempt"))!;
        assert.equal(
          await tx.attempts.finish({
            ...attempt,
            finishedAt: tx.now,
            outcome: "accepted",
            providerReceiptId: "provider-ack",
          }),
          true,
        );
        const id = pagingWorkId(scope, "receipt", "delivery", "attempt");
        await tx.work.enqueue("job", {
          id,
          kind: "paging.receipt",
          idempotencyKey: id,
          dueAt: tx.now,
          payload: {
            pageId: "page",
            deliveryId: "delivery",
            attemptId: "attempt",
            receiptId: "provider-ack",
            secretId: "secret",
            approvedSecretIds: ["secret"],
            pollUntil: new Date(Date.parse(tx.now) + 600_000).toISOString(),
          },
        });
      });
      const lease = await f.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["paging.receipt"],
        token: randomUUID(),
        leaseMs: 60_000,
      });
      assert.ok(lease);
      let inspected = 0;
      const channel: ReceiptChannel = {
        send: async () => {
          throw new Error("Receipt replay must not send a page");
        },
        inspect: async () => {
          inspected++;
          return { state: "acknowledged", acknowledgedAt };
        },
        cancel: async () => "cancelled",
      };
      assert.deepEqual(
        await new PagingProviderJobs(f.repository, channel).poll(
          lease,
          new AbortController().signal,
        ),
        { state: "completed" },
      );
      const first = await f.repository.transaction(scope, (tx) =>
        tx.pages.get("page"),
      );
      assert.deepEqual(
        await new PagingProviderJobs(f.reopen(), channel).poll(
          lease,
          new AbortController().signal,
        ),
        { state: "stale" },
      );
      assert.equal(inspected, 1);
      await f.reopen().transaction(scope, async (tx) => {
        const page = await tx.pages.get("page");
        assert.equal(page?.state, "acknowledged");
        assert.equal(page?.acknowledgedBy, "primary");
        assert.equal(page?.acknowledgedAt, first?.acknowledgedAt);
        assert.equal(page?.revision, first?.revision);
        assert.equal(
          (await tx.attempts.get("attempt"))?.providerReceiptId,
          "provider-ack",
        );
        assert.equal(await tx.work.lockClaim(lease), undefined);
      });
    },
  );
  for (const lost of [false, true])
    scenario(
      lost
        ? "lost provider response persists uncertainty and a retryable outbox"
        : "permanent provider failure persists rejection without acknowledging the page",
      async (f, scope) => {
        const lease = await queued(f, scope);
        const result = await sender(f.repository, {
          send: async () => {
            if (lost)
              throw new Error("Response lost after provider acceptance");
            return {
              outcome: "rejected",
              retryable: false,
              reason: "provider_rejected",
            };
          },
        }).send(lease, new AbortController().signal);
        assert.equal(result.state, lost ? "retry" : "failed");
        assert.equal(await f.work.settle(lease, result), true);
        await f.reopen().transaction(scope, async (tx) => {
          const rows = (
            await tx.attempts.forDelivery("queued-delivery", { limit: 10 })
          ).items;
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.outcome, lost ? "unknown" : "failed");
          assert.equal(rows[0]?.retryable, lost);
          assert.equal(rows[0]?.providerReceiptId, null);
          assert.equal((await tx.pages.get("queued-page"))?.state, "open");
          assert.equal(
            await tx.work.enqueue("outbox", {
              id: lease.id,
              kind: lease.kind,
              idempotencyKey: lease.id,
              payload: lease.payload,
              dueAt: tx.now,
            }),
            "duplicate",
          );
        });
      },
    );
  scenario(
    "downtime beyond the terminal deadline records exhaustion without resolution",
    async (f, scope) => {
      await f.repository.transaction(scope, async (tx) => {
        const createdAt = new Date(Date.parse(tx.now) - 180_000).toISOString();
        await tx.incidents.insert({
          ...(await tx.incidents.get("incident"))!,
          id: "overdue-incident",
          openedAt: createdAt,
        });
        await tx.pages.insert({
          ...(await tx.pages.get("page"))!,
          id: "overdue-page",
          incidentId: "overdue-incident",
          createdAt,
        });
        const id = pagingWorkId(scope, "step", "overdue-page", "initial");
        await tx.work.enqueue("job", {
          id,
          kind: "paging.step",
          idempotencyKey: id,
          dueAt: createdAt,
          payload: { pageId: "overdue-page", logicalStepId: "initial" },
        });
      });
      const repo = f.reopen();
      const dispatch: DispatchRepository = {
        transaction: (workspace, run) =>
          repo.transaction(workspace, (tx) =>
            run({
              ...tx,
              routing: {
                schedule: async () => undefined,
                contacts: async () => [],
              },
            }),
          ),
      };
      const lease = await f.work.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["paging.step"],
        token: randomUUID(),
        leaseMs: 60_000,
      });
      assert.ok(lease);
      const result = await new PageAdvancement(dispatch).advance(lease);
      await f.work.settle(lease, result);
      await f.reopen().transaction(scope, async (tx) => {
        const page = await tx.pages.get("overdue-page");
        assert.equal(page?.state, "exhausted");
        assert.equal(page?.resolvedAt, null);
        assert.equal(
          (await tx.incidents.get("overdue-incident"))?.resolvedAt,
          null,
        );
        const rows = (await tx.steps.forPage("overdue-page", { limit: 10 }))
          .items;
        assert.ok(rows.some((row) => row.disposition === "skipped"));
        assert.ok(
          rows.some(
            (row) =>
              row.logicalStepId === "terminal" &&
              row.disposition === "uncovered",
          ),
        );
      });
    },
  );
}
