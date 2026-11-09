import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { postgresMetricsStore } from "../../src/platform/database/postgres-metrics.store.js";
function harness(changed = 1) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: changed };
    },
  } as unknown as PoolClient;
  return {
    calls,
    store: postgresMetricsStore(connection, workspaceIdSchema.parse("tenant")),
  };
}
test("metrics reads bind scope, cursor ownership and historical receipt visibility", async () => {
  const { store, calls } = harness();
  const hostile = "monitor' OR true --";
  await store.get(hostile, true);
  await store.history(hostile, { after: "foreign-receipt", limit: 10 });
  await store.window({
    monitorId: hostile,
    monitorVersion: 2,
    startAt: "2026-10-03T00:00:00.000Z",
    endAt: "2026-10-03T00:01:00.000Z",
    visibleAt: "2026-10-03T00:02:00.000Z",
    limit: 2,
  });
  assert.deepEqual(calls[0].values, ["tenant", hostile]);
  assert.match(calls[0].sql, /workspace_id=\$1 AND id=\$2 FOR UPDATE/);
  assert.deepEqual(calls[1].values, ["tenant", hostile, "foreign-receipt", 11]);
  assert.match(
    calls[1].sql,
    /SELECT received_at,id FROM escalator_metric_observation WHERE workspace_id=\$1 AND monitor_id=\$2 AND id=\$3/,
  );
  assert.match(calls[2].sql, /received_at<=\$6::timestamptz/);
  assert.match(calls[2].sql, /ORDER BY observed_at,received_at DESC,id DESC/);
  for (const call of calls) assert.equal(call.sql.includes(hostile), false);
});
