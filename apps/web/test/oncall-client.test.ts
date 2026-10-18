import test from "node:test";
import assert from "node:assert/strict";
import { oncallClient } from "../src/routes/oncall/oncall-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("coverage reads and saved previews use distinct authenticated procedures", async () => {
  const calls: unknown[][] = [];
  const client = oncallClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  const input = {
    scheduleId: "schedule",
    startsAt: "2026-09-20T00:00:00.000Z",
    endsAt: "2026-09-21T00:00:00.000Z",
  };
  await client.coverage(input);
  await client.preview(input);
  assert.deepEqual(calls, [
    ["query", "configuration.coverage", input],
    ["mutate", "configuration.preview", input],
  ]);
});
