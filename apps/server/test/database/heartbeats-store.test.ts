import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { postgresHeartbeatStore } from "../../src/platform/database/postgres-heartbeats.store.js";
test("heartbeat grant reads hold a scoped row lock and revocation binds its timestamp", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const store = postgresHeartbeatStore(
    connection,
    workspaceIdSchema.parse("local"),
  );
  await store.grantByHash("a".repeat(64));
  assert.match(calls[0].sql, /workspace_id=\$1 AND token_hash=\$2 FOR UPDATE$/);
  assert.deepEqual(calls[0].values, ["local", "a".repeat(64)]);
  await store.revokeGrant("grant", "2026-10-03T00:00:00.000Z");
  assert.match(calls[1].sql, /to_jsonb\(\$3::text\)/);
  assert.deepEqual(calls[1].values, [
    "local",
    "grant",
    "2026-10-03T00:00:00.000Z",
  ]);
});
