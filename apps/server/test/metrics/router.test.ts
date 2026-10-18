import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { metricsRouter } from "../../src/features/metrics/metrics.router.js";
const input = {
  name: "Health",
  serviceId: "api",
  environmentId: "prod",
  enabled: false,
  stepSeconds: 60,
  query: {
    connection: {
      provider: "prometheus" as const,
      baseUrl: "https://example.test",
      authSecretId: null,
    },
    requestsQuery: "requests",
    errorsQuery: "errors",
  },
  rule: {
    windowSeconds: 120,
    minimumSamples: 2,
    minimumRequests: 100,
    errorRateFloor: 0.05,
  },
};
test("metric routes derive identity from the current local session and reject scope injection", async () => {
  const calls: unknown[] = [];
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    metrics: {
      create: async (actor: unknown) => {
        calls.push(actor);
        return { id: "metric" };
      },
      list: async (actor: unknown) => {
        calls.push(actor);
        return { items: [], next: null };
      },
    },
  } as unknown as AppContext;
  const caller = metricsRouter.createCaller(context);
  await caller.create(input);
  await caller.list({});
  assert.deepEqual(
    calls,
    Array(2).fill({
      workspaceId: "local",
      responderId: "admin",
      role: "administrator",
    }),
  );
  await assert.rejects(
    caller.create({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  delete context.req.session.account;
  await assert.rejects(caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(calls.length, 2);
});
test("metric routes return actionable policy and capacity errors with no private details", async () => {
  let code = "destination_denied";
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    metrics: {
      create: async () => {
        throw Object.assign(new Error("private.example"), { code });
      },
    },
  } as unknown as AppContext;
  const caller = metricsRouter.createCaller(context);
  for (code of [
    "destination_denied",
    "configured_limit",
    "active_limit",
    "request_budget",
  ])
    await assert.rejects(caller.create(input), (error: unknown) => {
      const value = error as { code: string; message: string };
      assert.equal(value.code, "PRECONDITION_FAILED");
      assert.ok(!value.message.includes("private.example"));
      return true;
    });
});
