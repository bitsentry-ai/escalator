import test from "node:test";
import assert from "node:assert/strict";
import { heartbeatsClient } from "../src/routes/heartbeats/heartbeats-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("heartbeat administration routes configuration and scoped grant operations through the host", async () => {
  const calls: unknown[][] = [];
  const client = heartbeatsClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  await client.get({ id: "heartbeat" });
  await client.disable({ id: "heartbeat", expectedVersion: 7 });
  await client.grants({ id: "heartbeat", limit: 25 });
  await client.issueGrant({
    id: "heartbeat",
    expiresAt: "2026-11-01T00:00:00.000Z",
  });
  await client.revokeGrant({ id: "heartbeat", grantId: "grant" });
  assert.deepEqual(calls, [
    ["query", "heartbeats.get", { id: "heartbeat" }],
    ["mutate", "heartbeats.disable", { id: "heartbeat", expectedVersion: 7 }],
    ["query", "heartbeats.grants", { id: "heartbeat", limit: 25 }],
    [
      "mutate",
      "heartbeats.issueGrant",
      { id: "heartbeat", expiresAt: "2026-11-01T00:00:00.000Z" },
    ],
    ["mutate", "heartbeats.revokeGrant", { id: "heartbeat", grantId: "grant" }],
  ]);
});
