import test from "node:test";
import assert from "node:assert/strict";
import { probesClient } from "../src/routes/probes/probes-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("probe history and configuration use authenticated host procedures and preserve version checks", async () => {
  const calls: unknown[][] = [];
  const client = probesClient({
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
  await client.get({ id: "probe" });
  await client.secretOptions({ limit: 25 });
  await client.createMonitoringSecret!({
    name: "API",
    kind: "http-probe",
    credentials: { header: "authorization", value: "Bearer fixture" },
  });
  await client.history({ id: "probe", after: "receipt", limit: 10 });
  await client.disable({ id: "probe", expectedVersion: 7 });
  assert.deepEqual(calls, [
    ["query", "probes.list", { limit: 25 }],
    ["query", "probes.get", { id: "probe" }],
    ["query", "monitoringSecrets.list", { limit: 25 }],
    [
      "mutate",
      "monitoringSecrets.create",
      {
        name: "API",
        kind: "http-probe",
        credentials: { header: "authorization", value: "Bearer fixture" },
      },
    ],
    ["query", "probes.history", { id: "probe", after: "receipt", limit: 10 }],
    ["mutate", "probes.disable", { id: "probe", expectedVersion: 7 }],
  ]);
});
