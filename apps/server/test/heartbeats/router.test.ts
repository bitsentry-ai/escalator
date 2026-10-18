import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { heartbeatsRouter } from "../../src/features/heartbeats/heartbeats.router.js";
test("heartbeat routes use the local session and reject scope injection and stale sessions", async () => {
  const calls: unknown[] = [];
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    heartbeats: {
      create: async (actor: unknown, input: unknown) => {
        calls.push([actor, input]);
        return { id: "heartbeat" };
      },
    },
  } as unknown as AppContext;
  const caller = heartbeatsRouter.createCaller(context);
  const input = { name: "Cron", serviceId: "api", environmentId: "prod" };
  await caller.create(input);
  assert.deepEqual(calls[0], [
    { workspaceId: "local", responderId: "admin", role: "administrator" },
    { ...input, enabled: false, intervalSeconds: 60, graceSeconds: 10 },
  ]);
  await assert.rejects(
    caller.create({ ...input, workspaceId: "other" } as never),
    { code: "BAD_REQUEST" },
  );
  delete context.req.session.account;
  await assert.rejects(caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(calls.length, 1);
});
test("heartbeat issuance returns an actionable expiry error without internal details", async () => {
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    heartbeats: {
      issueGrant: async () => {
        throw Object.assign(new Error("private"), { code: "invalid_expiry" });
      },
    },
  } as unknown as AppContext;
  await assert.rejects(
    heartbeatsRouter
      .createCaller(context)
      .issueGrant({ id: "heartbeat", expiresAt: "2026-10-03T00:00:00.000Z" }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "BAD_REQUEST");
      assert.equal((error as Error).message.includes("private"), false);
      return true;
    },
  );
});
