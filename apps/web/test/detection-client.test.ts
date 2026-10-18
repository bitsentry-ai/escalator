import test from "node:test";
import assert from "node:assert/strict";
import { detectionClient } from "../src/routes/detection/detection-client.js";
import type { LocalAuthClient } from "../src/auth/auth-client.js";
import {
  serviceIdSchema,
  environmentIdSchema,
} from "@bitsentry-escalator/features/contracts";
test("automatic paging maps trusted host procedures and preserves versioned policy selection", async () => {
  const calls: unknown[][] = [];
  const client = detectionClient({
    query: async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return {};
    },
    mutate: async (...args: unknown[]) => {
      calls.push(["mutate", ...args]);
      return {};
    },
  } as unknown as LocalAuthClient);
  const key = {
    serviceId: serviceIdSchema.parse("service"),
    environmentId: environmentIdSchema.parse("production"),
  };
  const input = {
    ...key,
    policyId: "policy",
    enabled: true,
    expectedVersion: 7,
  };
  await client.binding(key);
  await client.policies({ limit: 25 });
  await client.configureBinding(input);
  assert.deepEqual(calls, [
    ["query", "detection.getBinding", key],
    ["query", "configuration.policies", { limit: 25 }],
    ["mutate", "detection.configureBinding", input],
  ]);
});
