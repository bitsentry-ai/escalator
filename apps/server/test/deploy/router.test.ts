import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { deploymentsRouter } from "../../src/features/deploy/deploy.router.js";
function context(deployments: unknown) {
  return {
    workspaceId: "local",
    req: { session: { account: { accountId: "admin", authVersion: 1 } } },
    auth: { current: async () => ({ id: "admin", role: "administrator" }) },
    deployments,
  } as unknown as AppContext;
}
test("deployment administration derives the local actor and rejects scope injection and logged-out callers", async () => {
  const seen: unknown[] = [];
  const ctx = context({
    create: async (actor: unknown, input: unknown) => {
      seen.push([actor, input]);
      return { id: "target" };
    },
  });
  const caller = deploymentsRouter.createCaller(ctx);
  const input = {
    name: "API",
    serviceId: "api",
    environmentId: "prod",
    policyId: "policy",
    timeoutSeconds: 600,
  };
  await caller.create(input);
  assert.deepEqual(seen[0], [
    { workspaceId: "local", responderId: "admin", role: "administrator" },
    { ...input, enabled: true },
  ]);
  await assert.rejects(
    caller.create({ ...input, workspaceId: "other" } as never),
    { code: "BAD_REQUEST" },
  );
  delete ctx.req.session.account;
  await assert.rejects(caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(seen.length, 1);
});
test("deployment administration converts domain failures into bounded client errors", async () => {
  for (const [code, expected] of [
    ["disabled", "PRECONDITION_FAILED"],
    ["invalid_responder", "BAD_REQUEST"],
    ["forbidden", "FORBIDDEN"],
    ["conflict", "CONFLICT"],
  ]) {
    const ctx = context({
      issueToken: async () => {
        throw Object.assign(new Error("private.database"), { code });
      },
    });
    await assert.rejects(
      deploymentsRouter
        .createCaller(ctx)
        .issueGrant({ targetId: "target", capabilities: ["deployment:write"] }),
      (raw: unknown) => {
        const e = raw as { code: string; message: string };
        assert.equal(e.code, expected);
        assert.ok(!e.message.includes("private.database"));
        return true;
      },
    );
  }
});
