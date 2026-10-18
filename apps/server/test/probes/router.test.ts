import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { probesRouter } from "../../src/features/probes/probes.router.js";
const input = {
  name: "Health",
  serviceId: "api",
  environmentId: "prod",
  enabled: false,
  intervalSeconds: 60,
  critical: false,
  failureThreshold: 2,
  recoveryThreshold: 2,
  config: {
    url: "https://example.test/health",
    method: "GET" as const,
    body: null,
    authSecretId: null,
    timeoutMs: 1000,
    maxResponseBytes: 1000,
    assertions: { status: [200], contains: null, json: [] },
    syntheticWrite: null,
  },
};
test("probe routes derive identity from the current local session and reject scope injection", async () => {
  const calls: unknown[] = [];
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    probes: {
      create: async (actor: unknown) => {
        calls.push(actor);
        return { id: "probe" };
      },
      list: async (actor: unknown) => {
        calls.push(actor);
        return { items: [], next: null };
      },
    },
  } as unknown as AppContext;
  const caller = probesRouter.createCaller(context);
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
test("probe routes return actionable policy and capacity errors with no private details", async () => {
  let code = "destination_denied";
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    probes: {
      create: async () => {
        throw Object.assign(new Error("private.example"), { code });
      },
    },
  } as unknown as AppContext;
  const caller = probesRouter.createCaller(context);
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
