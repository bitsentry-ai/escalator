import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { investigationTransaction } from "../../src/platform/database/investigation-transaction.js";
const scope = workspaceIdSchema.parse("org_a");
function fixture() {
  const statements: string[] = [];
  const released: boolean[] = [];
  const db = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    },
    release: (destroy: boolean) => released.push(destroy),
  } as unknown as PoolClient;
  const pool = { connect: async () => db } as unknown as Pool;
  return { db, pool, statements, released };
}
test("successful investigation transactions commit before releasing their connection", async () => {
  const f = fixture();
  assert.equal(
    await investigationTransaction(f.pool, scope, async () => 42),
    42,
  );
  assert.equal(f.statements.at(-1), "COMMIT");
  assert.deepEqual(f.released, [false]);
});
test("failed investigation transactions roll back before reuse", async () => {
  const f = fixture();
  await assert.rejects(
    investigationTransaction(f.pool, scope, async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  assert.equal(f.statements.at(-1), "ROLLBACK");
  assert.deepEqual(f.released, [false]);
});
test("noncooperative transaction work times out and destroys its connection once", async () => {
  const f = fixture();
  await assert.rejects(
    investigationTransaction(f.pool, scope, () => new Promise(() => {}), 20),
    /timed out/,
  );
  assert.deepEqual(f.released, [true]);
  assert.equal(f.statements.includes("COMMIT"), false);
});
test("a connection acquired after the deadline is destroyed without starting work", async () => {
  const f = fixture();
  let deliver: (client: PoolClient) => void = () => {};
  const pool = {
    connect: () =>
      new Promise<PoolClient>((resolve) => {
        deliver = resolve;
      }),
  } as unknown as Pool;
  let ran = false;
  await assert.rejects(
    investigationTransaction(
      pool,
      scope,
      async () => {
        ran = true;
      },
      20,
    ),
    /timed out/,
  );
  deliver(f.db);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.deepEqual(f.released, [true]);
  assert.deepEqual(f.statements, []);
});
