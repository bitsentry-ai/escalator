import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  workspaceSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  FoundationRepository,
  DurableWorkStore,
  WorkLease,
  WorkIntent,
} from "@bitsentry-escalator/features/application";
import { DurableWorkRunner } from "@bitsentry-escalator/features/application";
export interface WorkFixture {
  committed(lease: WorkLease): Promise<boolean>;
  repository: FoundationRepository;
  store: DurableWorkStore;
  reopen(): DurableWorkStore;
  expire(lease: WorkLease): Promise<void>;
  dispose(): Promise<void>;
}
export function workConformance(
  name: string,
  create: () => Promise<WorkFixture>,
  options: {
    skip?: string;
    register?: (title: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title: string, run: () => Promise<void>) =>
      test(title, { skip: options.skip }, run));
  function scenario(
    title: string,
    run: (fixture: WorkFixture, scope: WorkspaceId) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const scope = workspaceIdSchema.parse(`work_${randomUUID()}`);
      try {
        await fixture.repository.transaction(scope, async (tx) => {
          await tx.workspace.insert(
            workspaceSchema.parse({
              id: scope,
              name: "Work fixture",
              createdAt: tx.now,
              updatedAt: tx.now,
            }),
          );
        });
        await run(fixture, scope);
      } finally {
        await fixture.dispose();
      }
    });
  }
  const claim = (
    fixture: WorkFixture,
    scope: WorkspaceId,
    store = fixture.store,
  ) =>
    store.claim({
      workspaceId: scope,
      queue: "outbox",
      kinds: ["send"],
      token: randomUUID(),
      leaseMs: 5000,
    });
  const enqueue = (fixture: WorkFixture, scope: WorkspaceId) =>
    fixture.repository.transaction(scope, (tx) =>
      tx.work.enqueue("outbox", {
        id: "intent_1",
        kind: "send",
        idempotencyKey: "logical_delivery",
        payload: { pageId: "page_1" },
        dueAt: tx.now,
      }),
    );
  scenario(
    "claim is visible outside its transaction before handler I/O",
    async (fixture, scope) => {
      await enqueue(fixture, scope);
      const runner = new DurableWorkRunner(
        fixture.store,
        {
          job: new Map(),
          outbox: new Map([
            [
              "send",
              async (lease) => {
                assert.equal(await fixture.committed(lease), true);
                return {
                  state: "completed" as const,
                  outcome: "accepted" as const,
                };
              },
            ],
          ]),
        },
        {
          leaseMs: 20_000,
          timeoutMs: 10_000,
          maxAttempts: 3,
          retryBaseMs: 1000,
          retryMaxMs: 60_000,
          token: randomUUID,
          random: () => 0.5,
        },
      );
      assert.equal(await runner.runOne(scope, "outbox"), "completed");
    },
  );
  scenario(
    "failed surrounding transaction rolls back durable intent",
    async (fixture, scope) => {
      await assert.rejects(
        fixture.repository.transaction(scope, async (tx) => {
          await tx.work.enqueue("outbox", {
            id: "intent_1",
            kind: "send",
            idempotencyKey: "logical_delivery",
            payload: {},
            dueAt: tx.now,
          });
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(await claim(fixture, scope), undefined);
    },
  );
  scenario(
    "idempotency retains one original intent and payload",
    async (fixture, scope) => {
      assert.equal(await enqueue(fixture, scope), "inserted");
      assert.equal(
        await fixture.repository.transaction(scope, (tx) =>
          tx.work.enqueue("outbox", {
            id: "replacement",
            kind: "send",
            idempotencyKey: "logical_delivery",
            payload: { pageId: "wrong" },
            dueAt: tx.now,
          }),
        ),
        "duplicate",
      );
      const lease = await claim(fixture, scope);
      assert.ok(lease);
      assert.equal(lease.id, "intent_1");
      assert.deepEqual(lease.payload, { pageId: "page_1" });
      assert.equal(
        await fixture.store.settle(lease, {
          state: "completed",
          outcome: "accepted",
        }),
        true,
      );
      assert.equal(await claim(fixture, scope), undefined);
    },
  );
  scenario(
    "expired lease cannot complete even before another claimant exists",
    async (fixture, scope) => {
      await enqueue(fixture, scope);
      const first = await claim(fixture, scope);
      assert.ok(first);
      await fixture.expire(first);
      assert.equal(
        await fixture.store.settle(first, {
          state: "completed",
          outcome: "accepted",
        }),
        false,
      );
      const reopened = fixture.reopen();
      const next = await claim(fixture, scope, reopened);
      assert.ok(next);
      assert.equal(next.attempt, 2);
      assert.notEqual(next.token, first.token);
      assert.equal(
        await fixture.store.settle(first, {
          state: "completed",
          outcome: "accepted",
        }),
        false,
      );
      assert.equal(
        await reopened.settle(next, {
          state: "completed",
          outcome: "accepted",
        }),
        true,
      );
    },
  );
  scenario(
    "two restarted claimants reclaim an expired lease only once",
    async (fixture, scope) => {
      await enqueue(fixture, scope);
      const first = await claim(fixture, scope);
      assert.ok(first);
      await fixture.expire(first);
      const leases = await Promise.all([
        claim(fixture, scope, fixture.reopen()),
        claim(fixture, scope, fixture.reopen()),
      ]);
      assert.equal(leases.filter(Boolean).length, 1);
    },
  );
  scenario(
    "cancellation stops pending work and fences an in-flight completion",
    async (fixture, scope) => {
      await enqueue(fixture, scope);
      const active = await claim(fixture, scope);
      assert.ok(active);
      await fixture.repository.transaction(scope, async (tx) => {
        await tx.work.enqueue("outbox", {
          id: "pending",
          kind: "send",
          idempotencyKey: "pending_delivery",
          payload: {},
          dueAt: tx.now,
        });
        assert.equal(
          await tx.work.cancel("outbox", ["intent_1", "pending"]),
          2,
        );
      });
      assert.equal(await claim(fixture, scope), undefined);
      assert.equal(
        await fixture.store.settle(active, {
          state: "completed",
          outcome: "accepted",
        }),
        false,
      );
    },
  );
  scenario(
    "future deadlines cannot be claimed and invalid writes poison the transaction",
    async (fixture, scope) => {
      await fixture.repository.transaction(scope, (tx) =>
        tx.work.enqueue("outbox", {
          id: "future",
          kind: "send",
          idempotencyKey: "future",
          payload: {},
          dueAt: new Date(Date.parse(tx.now) + 86_400_000).toISOString(),
        }),
      );
      assert.equal(await claim(fixture, scope), undefined);
      await assert.rejects(
        fixture.repository.transaction(scope, async (tx) => {
          await assert.rejects(
            tx.work.enqueue("outbox", { id: "", kind: "send" } as WorkIntent),
          );
        }),
      );
    },
  );
  scenario(
    "claims and completion stay scoped even when IDs coincide",
    async (fixture, scope) => {
      const other = workspaceIdSchema.parse(`other_${randomUUID()}`);
      await fixture.repository.transaction(other, async (tx) => {
        await tx.workspace.insert(
          workspaceSchema.parse({
            id: other,
            name: "Other",
            createdAt: tx.now,
            updatedAt: tx.now,
          }),
        );
        await tx.work.enqueue("outbox", {
          id: "intent_1",
          kind: "send",
          idempotencyKey: "logical_delivery",
          payload: { pageId: "other" },
          dueAt: tx.now,
        });
      });
      await enqueue(fixture, scope);
      const own = await claim(fixture, scope);
      const foreign = await claim(fixture, other);
      assert.ok(own && foreign);
      assert.deepEqual(own.payload, { pageId: "page_1" });
      assert.deepEqual(foreign.payload, { pageId: "other" });
      assert.equal(
        await fixture.store.settle(
          { ...own, workspaceId: other },
          { state: "completed", outcome: "accepted" },
        ),
        false,
      );
      assert.equal(
        await fixture.store.settle(foreign, {
          state: "completed",
          outcome: "accepted",
        }),
        true,
      );
    },
  );
  scenario(
    "job priority and allowed kinds govern claims independently of the outbox",
    async (fixture, scope) => {
      await fixture.repository.transaction(scope, async (tx) => {
        for (const [id, kind, priority] of [
          ["low", "page.step", 1],
          ["high", "page.step", 10],
          ["probe", "probe.run", 100],
        ] as const) {
          await tx.work.enqueue("job", {
            id,
            kind,
            priority,
            idempotencyKey: id,
            payload: {},
            dueAt: tx.now,
          });
        }
      });
      const first = await fixture.store.claim({
        workspaceId: scope,
        queue: "job",
        kinds: ["page.step"],
        token: randomUUID(),
        leaseMs: 5000,
      });
      assert.equal(first?.id, "high");
      assert.equal(await claim(fixture, scope), undefined);
    },
  );
}
