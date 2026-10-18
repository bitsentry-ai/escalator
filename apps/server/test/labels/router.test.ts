import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { labelsRouter } from "../../src/features/labels/labels.router.js";
function context(labels: unknown) {
  return {
    workspaceId: "local",
    req: { session: { account: { accountId: "reviewer", authVersion: 1 } } },
    auth: { current: async () => ({ id: "reviewer", role: "responder" }) },
    labels,
  } as unknown as AppContext;
}
test("label review derives authority from the current local session", async () => {
  const seen: unknown[] = [];
  const ctx = context({
    review: async (actor: unknown, input: unknown) => {
      seen.push([actor, input]);
      return { id: "label" };
    },
  });
  const caller = labelsRouter.createCaller(ctx);
  const input = { id: "label", expectedRevision: 1 };
  await caller.review(input);
  assert.deepEqual(seen, [
    [
      { workspaceId: "local", responderId: "reviewer", role: "responder" },
      input,
    ],
  ]);
  for (const extra of [
    { workspaceId: "other" },
    { reviewedBy: "admin" },
    { role: "administrator" },
    { actor: { role: "administrator" } },
  ]) {
    await assert.rejects(caller.review({ ...input, ...extra } as never), {
      code: "BAD_REQUEST",
    });
  }
  delete ctx.req.session.account;
  await assert.rejects(caller.review(input), { code: "UNAUTHORIZED" });
  assert.equal(seen.length, 1);
});
test("label APIs reject revoked local sessions before accessing persistence", async () => {
  let calls = 0;
  const ctx = context({
    get: async () => {
      calls++;
      return undefined;
    },
  });
  ctx.auth.current = async () => {
    throw Object.assign(new Error("revoked"), {
      code: "authentication_failed",
    });
  };
  await assert.rejects(labelsRouter.createCaller(ctx).get({ id: "label" }), {
    code: "UNAUTHORIZED",
  });
  assert.equal(calls, 0);
});
test("label conflicts and ownership failures conceal persistence details", async () => {
  for (const [code, expected] of [
    ["immutable", "CONFLICT"],
    ["conflict", "CONFLICT"],
    ["forbidden", "FORBIDDEN"],
    ["not_found", "NOT_FOUND"],
  ]) {
    const caller = labelsRouter.createCaller(
      context({
        review: async () => {
          throw Object.assign(new Error("private.database"), { code });
        },
      }),
    );
    await assert.rejects(
      caller.review({ id: "label", expectedRevision: 1 }),
      (raw: unknown) => {
        const error = raw as { code: string; message: string };
        assert.equal(error.code, expected);
        assert.ok(!error.message.includes("private.database"));
        return true;
      },
    );
  }
});
test("label list parses incident filtering and pagination without accepting tenant input", async () => {
  const seen: unknown[] = [];
  const caller = labelsRouter.createCaller(
    context({
      list: async (actor: unknown, input: unknown) => {
        seen.push([actor, input]);
        return { items: [], next: null };
      },
    }),
  );
  const query = {
    serviceId: "api",
    environmentId: "prod",
    incidentId: "incident",
  };
  await caller.list(query as never);
  assert.deepEqual(seen, [
    [
      { workspaceId: "local", responderId: "reviewer", role: "responder" },
      { ...query, limit: 50 },
    ],
  ]);
  await assert.rejects(
    caller.list({ ...query, organizationId: "other" } as never),
    { code: "BAD_REQUEST" },
  );
});
