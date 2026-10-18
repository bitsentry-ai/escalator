import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";
import { withBoundedRulePool } from "../../src/platform/database/bounded-rule-pool.js";
const scope = workspaceIdSchema.parse("rules-org");
function fixture() {
  const statements: string[] = [],
    released: boolean[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [{ now: new Date("2026-10-07T00:00:00Z") }] };
    },
    release: (destroy = false) => {
      released.push(destroy);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, statements, released };
}
test("bounded rule work uses the existing foundation transaction and releases after commit", async () => {
  const f = fixture();
  const result = await withBoundedRulePool(f.pool, (pool) =>
    new PostgresFoundationRepository(pool).transaction(
      scope,
      async (tx) => tx.workspaceId,
    ),
  );
  assert.equal(result, scope);
  assert.equal(f.statements.at(-1), "COMMIT");
  assert.deepEqual(f.released, [false]);
});
test("failed bounded rule work rolls back and preserves its original error", async () => {
  const f = fixture();
  await assert.rejects(
    withBoundedRulePool(f.pool, (pool) =>
      new PostgresFoundationRepository(pool).transaction(scope, async () => {
        throw new Error("original");
      }),
    ),
    /original/,
  );
  assert.equal(f.statements.at(-1), "ROLLBACK");
  assert.deepEqual(f.released, [false]);
});
test("the deadline destroys a stalled connection and prevents a late commit", async () => {
  const f = fixture();
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await assert.rejects(
    withBoundedRulePool(
      f.pool,
      (pool) =>
        new PostgresFoundationRepository(pool).transaction(scope, async () => {
          await gate;
        }),
      20,
    ),
    /deadline/,
  );
  resume();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.released, [true]);
  assert.equal(f.statements.includes("COMMIT"), false);
});
test("a connection delivered after timeout is destroyed without BEGIN", async () => {
  const f = fixture();
  let deliver: (db: PoolClient) => void = () => {};
  const pool = {
    connect: () =>
      new Promise<PoolClient>((resolve) => {
        deliver = resolve;
      }),
  } as unknown as Pool;
  await assert.rejects(
    withBoundedRulePool(
      pool,
      (p) =>
        new PostgresFoundationRepository(p).transaction(scope, async () => 42),
      20,
    ),
    /deadline/,
  );
  deliver(f.client);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.released, [true]);
  assert.deepEqual(f.statements, []);
});
test("escaped callbacks cannot use a released connection or acquire a second one", async () => {
  const f = fixture();
  let escaped: PoolClient | undefined;
  await withBoundedRulePool(f.pool, async (p) => {
    assert.throws(() => p.query("COMMIT"), /Only connection acquisition/);
    escaped = await p.connect();
    await assert.rejects(p.connect(), /unavailable/);
  });
  assert.throws(() => escaped!.query("COMMIT"), /deadline/);
  assert.deepEqual(f.released, [true]);
  assert.deepEqual(f.statements, []);
});

test("a delayed timer cannot permit COMMIT after synchronous callback work", async () => {
  const f = fixture();
  let now = 0;
  await assert.rejects(
    withBoundedRulePool(
      f.pool,
      (pool) =>
        new PostgresFoundationRepository(pool).transaction(scope, async () => {
          now = 11;
          return 42;
        }),
      10,
      () => now,
    ),
    /deadline/,
  );
  assert.equal(f.statements.includes("COMMIT"), false);
  assert.deepEqual(f.released, [true]);
});
test("elapsed acquisition time is checked before BEGIN even before the timer runs", async () => {
  const f = fixture();
  let now = 0;
  const pool = {
    connect: async () => {
      now = 11;
      return f.client;
    },
  } as unknown as Pool;
  await assert.rejects(
    withBoundedRulePool(
      pool,
      (bounded) =>
        new PostgresFoundationRepository(bounded).transaction(
          scope,
          async () => 42,
        ),
      10,
      () => now,
    ),
    /deadline/,
  );
  assert.deepEqual(f.statements, []);
  assert.deepEqual(f.released, [true]);
});
test("callback completion checks elapsed time without relying on a timer turn", async () => {
  const f = fixture();
  let now = 0;
  await assert.rejects(
    withBoundedRulePool(
      f.pool,
      async () => {
        now = 11;
        return 42;
      },
      10,
      () => now,
    ),
    /deadline/,
  );
});
