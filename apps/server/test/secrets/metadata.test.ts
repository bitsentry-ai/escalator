import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PostgresSecretWriter } from "../../src/platform/secrets/postgres-secret.writer.js";
import type { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
test("metadata selection is bounded and scoped without decrypting credentials", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  let releases = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return {
          rows: sql.includes("SELECT id,name")
            ? [
                { id: "b", name: "B" },
                { id: "c", name: "C" },
                { id: "d", name: "D" },
              ]
            : [],
        };
      },
      release: () => {
        releases++;
      },
    }),
  } as unknown as Pool;
  const writer = new PostgresSecretWriter(pool, {} as SecretKeyRing);
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("local"),
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  assert.deepEqual(await writer.list(actor, { limit: 2, after: "a" }), {
    items: [
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    next: "c",
  });
  assert.ok(
    calls.some(
      (call) => call.sql.includes("set_config") && call.values[0] === "local",
    ),
  );
  const select = calls.find((call) => call.sql.includes("SELECT id,name"))!;
  assert.deepEqual(select.values, ["local", "a", 3]);
  assert.match(select.sql, /purpose='provider'.*disabled_at IS NULL/s);
  assert.doesNotMatch(select.sql, /envelope/);
  assert.equal(releases, 1);
  const count = calls.length;
  await assert.rejects(writer.list({ ...actor, role: "viewer" }, {}), {
    code: "secret_unavailable",
  });
  await assert.rejects(writer.list(actor, { limit: 51 }));
  assert.equal(calls.length, count);
});
