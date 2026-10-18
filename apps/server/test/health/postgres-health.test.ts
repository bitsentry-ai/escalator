import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { PostgresHealthReader } from "../../src/platform/health/postgres-health.reader.js";
const scope = workspaceIdSchema.parse("local-health");
const now = new Date("2026-10-03T00:00:00.000Z");
function fixture(
  rows: unknown[] = [
    {
      database_now: now,
      oldest_job: null,
      oldest_outbox: null,
      oldest_paging: null,
    },
  ],
) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const released: unknown[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: sql.includes("AS database_now") ? rows : [] };
    },
    release(destroy?: boolean) {
      released.push(destroy);
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  return {
    reader: new PostgresHealthReader(pool as unknown as Pool),
    client,
    pool,
    queries,
    released,
  };
}
test("health reads use one scoped read-only snapshot with bounded SQL", async () => {
  const f = fixture([
    {
      database_now: now,
      oldest_job: new Date(now.getTime() - 120000),
      oldest_outbox: null,
      oldest_paging: new Date(now.getTime() - 60000),
    },
  ]);
  const result = await f.reader.read(scope, new AbortController().signal);
  assert.equal(result.databaseNow, now.toISOString());
  assert.equal(result.oldestDueJobAt, "2026-10-02T23:58:00.000Z");
  assert.equal(result.oldestDuePagingAt, "2026-10-02T23:59:00.000Z");
  assert.equal(f.queries[0].sql, "BEGIN READ ONLY");
  assert.ok(f.queries.some((q) => q.sql.includes("statement_timeout = '1s'")));
  assert.deepEqual(
    f.queries.find((q) => q.sql.includes("set_config"))?.values,
    [scope],
  );
  const query = f.queries.find((q) => q.sql.includes("AS database_now"))!;
  assert.deepEqual(query.values, [scope, "health.watchdog."]);
  assert.equal((query.sql.match(/workspace_id=\$1/g) ?? []).length, 3);
  assert.match(query.sql, /FROM escalator_workspace WHERE id=\$1/);
  assert.match(query.sql, /state IN \('pending','running'\)/);
  assert.equal(f.queries.at(-1)?.sql, "COMMIT");
  assert.deepEqual(f.released, [undefined]);
});
test("missing workspace and invalid database timestamps fail and destroy the checkout", async () => {
  for (const rows of [
    [],
    [
      {
        database_now: "invalid",
        oldest_job: null,
        oldest_outbox: null,
        oldest_paging: null,
      },
    ],
  ]) {
    const f = fixture(rows);
    await assert.rejects(
      f.reader.read(scope, new AbortController().signal),
      /Operational health database unavailable/,
    );
    assert.deepEqual(f.released, [true]);
    assert.ok(!f.queries.some((q) => q.sql === "COMMIT"));
  }
});
test("cancellation while waiting returns a late checkout without issuing SQL", async () => {
  const f = fixture();
  let deliver!: (client: typeof f.client) => void;
  f.pool.connect = () =>
    new Promise((resolve) => {
      deliver = resolve;
    });
  const controller = new AbortController();
  const result = f.reader.read(scope, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result, /Health connection unavailable/);
  await assert.rejects(
    f.reader.read(scope, new AbortController().signal),
    /Health connection unavailable/,
  );
  deliver(f.client);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.released, [undefined]);
  assert.equal(f.queries.length, 0);
});
test("cancellation during a query destroys its connection exactly once", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.client.query = async () => {
    controller.abort();
    throw new Error("private database detail");
  };
  await assert.rejects(
    f.reader.read(scope, controller.signal),
    (error) =>
      error instanceof Error &&
      error.message === "Operational health database unavailable",
  );
  assert.deepEqual(f.released, [true]);
});
test("already cancelled health checks do not acquire a connection", async () => {
  const f = fixture();
  let acquired = false;
  f.pool.connect = async () => {
    acquired = true;
    return f.client;
  };
  await assert.rejects(f.reader.read(scope, AbortSignal.abort()));
  assert.equal(acquired, false);
});
test("pool rejection is redacted", async () => {
  const reader = new PostgresHealthReader({
    connect: async () => {
      throw new Error("private connection details");
    },
  } as unknown as Pool);
  await assert.rejects(
    reader.read(scope, new AbortController().signal),
    /Health connection unavailable/,
  );
});

test("immediate cancellation prevents a queued pool acquisition", async () => {
  const f = fixture();
  let acquired = false;
  f.pool.connect = async () => {
    acquired = true;
    return f.client;
  };
  const controller = new AbortController();
  const result = f.reader.read(scope, controller.signal);
  controller.abort();
  await assert.rejects(result);
  assert.equal(acquired, false);
});
