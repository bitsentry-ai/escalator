import test from "node:test";
import assert from "node:assert/strict";
import { metricsClient } from "../src/routes/metrics/metrics-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
test("metric inspection, disable and credential creation use authenticated host procedures", async () => {
  const calls: unknown[][] = [];
  const client = metricsClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  await client.get({ id: "metric" });
  await client.history({ id: "metric", limit: 25 });
  await client.disable({ id: "metric", expectedVersion: 7 });
  await client.createMonitoringSecret!({
    name: "Prometheus",
    kind: "metrics",
    credentials: { authorization: "Bearer fixture" },
  });
  assert.deepEqual(calls, [
    ["query", "metrics.get", { id: "metric" }],
    ["query", "metrics.history", { id: "metric", limit: 25 }],
    ["mutate", "metrics.disable", { id: "metric", expectedVersion: 7 }],
    [
      "mutate",
      "monitoringSecrets.create",
      {
        name: "Prometheus",
        kind: "metrics",
        credentials: { authorization: "Bearer fixture" },
      },
    ],
  ]);
});
