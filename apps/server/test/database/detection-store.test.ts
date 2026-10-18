import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { postgresDetectionStore } from "../../src/platform/database/postgres-detection.store.js";
test("missing group locks are transaction-scoped, tenant-specific and precede reads", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const hostile = "group' OR true --";
  for (const scope of ["tenant-a", "tenant-b"]) {
    const store = postgresDetectionStore(
      connection,
      workspaceIdSchema.parse(scope),
    );
    assert.equal(await store.lockGroup(hostile), undefined);
  }
  assert.equal(calls.length, 4);
  for (const start of [0, 2]) {
    assert.match(calls[start].sql, /pg_advisory_xact_lock/);
    assert.match(calls[start + 1].sql, /workspace_id=\$1 AND id=\$2/);
    assert.equal(calls[start + 1].values[1], hostile);
    assert.equal(calls[start].sql.includes(hostile), false);
  }
  assert.notEqual(calls[0].values[0], calls[2].values[0]);
});
