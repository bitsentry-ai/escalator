import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { postgresConfigurationStore } from "../../src/platform/database/postgres-configuration.store.js";
function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const scope = workspaceIdSchema.parse("organization-one");
  return {
    store: postgresConfigurationStore(client, scope),
    calls,
    scope,
  };
}
test("configuration queries bind scope and identifiers instead of interpolating callers", async () => {
  const f = fixture();
  const untrusted = "x' OR TRUE --";
  await f.store.get("schedules", untrusted, true);
  await f.store.list("contacts", { limit: 10, after: untrusted }, untrusted);
  for (const call of f.calls) {
    assert.equal(call.sql.includes(untrusted), false);
    assert.equal(call.values[0], f.scope);
    assert.match(call.sql, /workspace_id=\$1/);
  }
  assert.match(f.calls[0].sql, /FOR UPDATE$/);
  assert.match(f.calls[1].sql, /responder_id=\$4/);
});
test("contact metadata lookup excludes authentication secrets and never reads envelopes", async () => {
  const f = fixture();
  assert.equal(await f.store.secretExists("secret", "webhook"), true);
  const call = f.calls[0];
  assert.match(call.sql, /^SELECT 1 /);
  assert.match(call.sql, /channel=\$3/);
  assert.match(call.sql, /disabled_at IS NULL/);
  assert.match(call.sql, /purpose='provider'/);
  assert.equal(call.sql.includes("envelope"), false);
  assert.deepEqual(call.values, [f.scope, "secret", "webhook"]);
});
