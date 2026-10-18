import test from "node:test";
import assert from "node:assert/strict";
import { incidentsClient } from "../src/routes/incidents/incidents-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("incident transport keeps reads and resolution on their authenticated tRPC procedures", async () => {
  const calls: unknown[][] = [];
  const client = incidentsClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  await client.detail({ id: "incident" });
  await client.resolve({ id: "incident" });
  await client.policies({ limit: 25 });
  assert.deepEqual(calls, [
    ["query", "incidents.detail", { id: "incident" }],
    ["mutate", "incidents.resolve", { id: "incident" }],
    ["query", "incidents.policies", { limit: 25 }],
  ]);
});
