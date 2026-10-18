import test from "node:test";
import assert from "node:assert/strict";
import { sourcesClient } from "../src/routes/sources/sources-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("source administration uses authenticated host procedures and keeps grant secrets out of query input", async () => {
  const calls: unknown[][] = [];
  const client = sourcesClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  await client.list({ limit: 25 });
  await client.grants({ sourceId: "source", after: "grant", limit: 10 });
  await client.issueReceiver({ sourceId: "source", ttlSeconds: 86400 });
  await client.revoke({ id: "grant" });
  assert.deepEqual(calls, [
    ["query", "signals.list", { limit: 25 }],
    [
      "query",
      "signals.tokens",
      { sourceId: "source", after: "grant", limit: 10 },
    ],
    [
      "mutate",
      "signals.issueReceiver",
      { sourceId: "source", ttlSeconds: 86400 },
    ],
    ["mutate", "signals.revokeToken", { id: "grant" }],
  ]);
});
