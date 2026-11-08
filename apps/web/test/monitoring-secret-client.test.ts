import test from "node:test";
import assert from "node:assert/strict";
import { metricsClient } from "../src/routes/metrics/metrics-client.js";
import { probesClient } from "../src/routes/probes/probes-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";

// Query input travels in the URL, so credential-bearing calls must be mutations.
test("monitoring credentials are sent as a mutation body, never as query input", async () => {
  const cases = [
    {
      create: metricsClient,
      input: {
        name: "Prometheus",
        kind: "metrics",
        credentials: { authorization: "Bearer fixture" },
      },
    },
    {
      create: probesClient,
      input: {
        name: "API",
        kind: "http-probe",
        credentials: { header: "authorization", value: "Bearer fixture" },
      },
    },
  ] as const;
  for (const { create, input } of cases) {
    const calls: unknown[][] = [];
    const client = create({
      query: async (...args: unknown[]) => {
        calls.push(["query", ...args]);
        return {};
      },
      mutate: async (...args: unknown[]) => {
        calls.push(["mutate", ...args]);
        return {};
      },
    } as unknown as LocalAuthClient);
    await client.createMonitoringSecret!(input);
    assert.deepEqual(calls, [["mutate", "monitoringSecrets.create", input]]);
  }
});
