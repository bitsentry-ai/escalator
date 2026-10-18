import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  workspaceSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  defaultHealthPolicy,
  evaluateHealth,
  type OperationalHealthReader,
  type FoundationRepository,
  type DurableWorkStore,
  type WorkQueue,
} from "@bitsentry-escalator/features/application";
interface HealthFixture {
  repository: FoundationRepository;
  reader: OperationalHealthReader;
  store: DurableWorkStore;
  dispose(): Promise<void>;
}
/** Identical queue-age and scope cases for both production database adapters. */
export function healthConformance(
  name: string,
  create: () => Promise<HealthFixture>,
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
    run: (f: HealthFixture, a: WorkspaceId, b: WorkspaceId) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const f = await create();
      const a = workspaceIdSchema.parse(`health_a_${randomUUID()}`),
        b = workspaceIdSchema.parse(`health_b_${randomUUID()}`);
      try {
        for (const id of [a, b])
          await f.repository.transaction(id, async (tx) => {
            await tx.workspace.insert(
              workspaceSchema.parse({
                id,
                name: "Health fixture",
                createdAt: tx.now,
                updatedAt: tx.now,
              }),
            );
          });
        await run(f, a, b);
      } finally {
        await f.dispose();
      }
    });
  }
  const read = (f: HealthFixture, scope: WorkspaceId) =>
    f.reader.read(scope, new AbortController().signal);
  const enqueue = (
    f: HealthFixture,
    scope: WorkspaceId,
    queue: WorkQueue,
    kind: string,
    offset = -600000,
  ) =>
    f.repository.transaction(scope, async (tx) => {
      const id = randomUUID(),
        dueAt = new Date(Date.parse(tx.now) + offset).toISOString();
      await tx.work.enqueue(queue, {
        id,
        idempotencyKey: id,
        kind,
        payload: {},
        dueAt,
      });
      return dueAt;
    });
  scenario(
    "existing empty scope is healthy; nonexistent scope fails",
    async (f, a) => {
      const snapshot = await read(f, a);
      assert.ok(Number.isFinite(Date.parse(snapshot.databaseNow)));
      assert.equal(snapshot.oldestDueJobAt, null);
      assert.equal(snapshot.oldestDueOutboxAt, null);
      assert.equal(snapshot.oldestDuePagingAt, null);
      await assert.rejects(
        read(f, workspaceIdSchema.parse(`absent_${randomUUID()}`)),
      );
    },
  );
  scenario(
    "all three queue ages are scoped and overdue work fails readiness",
    async (f, a, b) => {
      const other = await enqueue(f, b, "job", "paging.step", -3600000);
      const job = await enqueue(f, a, "job", "signal.process");
      const page = await enqueue(f, a, "job", "paging.step", -120000);
      const outbox = await enqueue(f, a, "outbox", "paging.send", -90000);
      const snapshot = await read(f, a);
      assert.notEqual(snapshot.oldestDueJobAt, other);
      assert.equal(snapshot.oldestDueJobAt, job);
      assert.equal(snapshot.oldestDuePagingAt, page);
      assert.equal(snapshot.oldestDueOutboxAt, outbox);
      const result = evaluateHealth(
        snapshot,
        { running: true, laneAgeMs: [0] },
        defaultHealthPolicy,
      );
      assert.equal(result.ready, false);
      assert.deepEqual(result.reasons, [
        "paging_overdue",
        "jobs_overdue",
        "outbox_overdue",
      ]);
    },
  );
  scenario(
    "running work remains overdue until completion; future work is excluded",
    async (f, a) => {
      const due = await enqueue(f, a, "job", "paging.step");
      await enqueue(f, a, "job", "paging.step", 3600000);
      const claim = await f.store.claim({
        workspaceId: a,
        queue: "job",
        kinds: ["paging.step"],
        token: randomUUID(),
        leaseMs: 30000,
      });
      assert.ok(claim);
      assert.equal((await read(f, a)).oldestDuePagingAt, due);
      assert.equal(await f.store.settle(claim, { state: "completed" }), true);
      const cleared = await read(f, a);
      assert.equal(cleared.oldestDuePagingAt, null);
      assert.equal(cleared.oldestDueJobAt, null);
    },
  );
  scenario(
    "watchdog job backlog cannot gate recovery, but outbox backlog still does",
    async (f, a) => {
      await enqueue(f, a, "job", `health.watchdog.${"a".repeat(64)}`);
      assert.equal((await read(f, a)).oldestDueJobAt, null);
      const due = await enqueue(
        f,
        a,
        "outbox",
        `health.watchdog.${"a".repeat(64)}`,
      );
      assert.equal((await read(f, a)).oldestDueOutboxAt, due);
    },
  );
  scenario(
    "unclaimed or long-running investigations cannot fail job readiness",
    async (f, a) => {
      await enqueue(f, a, "job", "investigation.run");
      assert.equal((await read(f, a)).oldestDueJobAt, null);
      const job = await enqueue(f, a, "job", "signal.process");
      assert.equal((await read(f, a)).oldestDueJobAt, job);
    },
  );
  scenario(
    "failed and cancelled jobs are excluded from pending queue age",
    async (f, a) => {
      await enqueue(f, a, "job", "paging.step");
      const claim = await f.store.claim({
        workspaceId: a,
        queue: "job",
        kinds: ["paging.step"],
        token: randomUUID(),
        leaseMs: 30000,
      });
      assert.ok(claim);
      assert.equal(await f.store.settle(claim, { state: "failed" }), true);
      await f.repository.transaction(a, async (tx) => {
        await tx.work.enqueue("job", {
          id: "cancelled",
          idempotencyKey: "cancelled",
          kind: "paging.step",
          payload: {},
          dueAt: tx.now,
        });
        await tx.work.cancel("job", ["cancelled"]);
      });
      assert.equal((await read(f, a)).oldestDueJobAt, null);
    },
  );
}
