import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { retentionRouter } from "../../src/features/retention/retention.router.js";
const input = { days: 30, maxBytes: 1024 ** 3, expectedVersion: null };
test("retention routes derive the current local actor and reject request scope injection", async () => {
  const seen: unknown[] = [];
  const ctx = {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    retention: {
      get: async (actor: unknown) => {
        seen.push(actor);
        return {};
      },
      update: async (actor: unknown) => {
        seen.push(actor);
        return {};
      },
    },
  } as unknown as AppContext;
  const caller = retentionRouter.createCaller(ctx);
  await caller.get();
  await caller.update(input);
  assert.deepEqual(
    seen,
    Array(2).fill({
      workspaceId: "local",
      responderId: "admin",
      role: "administrator",
    }),
  );
  await assert.rejects(
    caller.update({ ...input, workspaceId: "other" } as never),
    { code: "BAD_REQUEST" },
  );
  delete ctx.req.session.account;
  await assert.rejects(caller.get(), { code: "UNAUTHORIZED" });
  assert.equal(seen.length, 2);
});
test("busy and invalid-window responses disclose no repository details", async () => {
  let error: Error = Object.assign(new Error("private.internal"), {
    code: "retention_busy",
  });
  const ctx = {
    workspaceId: "local",
    req: { session: { account: {} } },
    auth: { current: async () => ({ id: "admin", role: "viewer" }) },
    retention: {
      get: async () => {
        throw error;
      },
    },
  } as unknown as AppContext;
  const caller = retentionRouter.createCaller(ctx);
  for (const code of ["TOO_MANY_REQUESTS", "BAD_REQUEST"]) {
    await assert.rejects(caller.get(), (raw: unknown) => {
      const e = raw as { code: string; message: string };
      assert.equal(e.code, code);
      assert.ok(!e.message.includes("private.internal"));
      return true;
    });
    error = new RangeError("private.internal");
  }
});
