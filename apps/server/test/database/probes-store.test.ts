import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { postgresProbeStore } from "../../src/platform/database/postgres-probes.store.js";
test("probe locks and paginated observations bind scope and caller values", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const hostile = "probe' OR true --";
  const store = postgresProbeStore(
    connection,
    workspaceIdSchema.parse("tenant"),
  );
  await store.get(hostile, true);
  await store.results(hostile, { after: "cursor", limit: 10 });
  assert.match(calls[0].sql, /workspace_id=\$1 AND id=\$2 FOR UPDATE/);
  assert.deepEqual(calls[0].values, ["tenant", hostile]);
  assert.deepEqual(calls[1].values, ["tenant", "cursor", 11, hostile]);
  for (const call of calls) assert.equal(call.sql.includes(hostile), false);
});

test("probe capacity mutexes use the workspace rather than an individual probe", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  for (const scope of ["tenant-a", "tenant-a", "tenant-b"])
    await postgresProbeStore(
      connection,
      workspaceIdSchema.parse(scope),
    ).lockCapacity();
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.equal(calls[0].values[0], calls[1].values[0]);
  assert.notEqual(calls[0].values[0], calls[2].values[0]);
  assert.equal(calls[0].values.length, 1);
});
