import { RuleRequestError } from "@bitsentry-escalator/features/application";
import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { rulesRouter } from "../../src/features/rules/rules.router.js";
function context(rules: unknown) {
  return {
    workspaceId: "local",
    req: { session: { account: { accountId: "owner", authVersion: 1 } } },
    auth: { current: async () => ({ id: "owner", role: "administrator" }) },
    rules,
  } as unknown as AppContext;
}
test("rule activation uses current local identity and rejects body-supplied authority", async () => {
  const seen: unknown[] = [],
    ctx = context({
      activation: {
        activate: async (actor: unknown, input: unknown) => {
          seen.push([actor, input]);
          return { id: "rule" };
        },
      },
    });
  const caller = rulesRouter.createCaller(ctx),
    input = { ruleId: "rule", receiptId: "receipt" };
  await caller.activate(input);
  assert.deepEqual(seen, [
    [
      { workspaceId: "local", responderId: "owner", role: "administrator" },
      input,
    ],
  ]);
  for (const extra of [
    { workspaceId: "foreign" },
    { role: "administrator" },
    { reviewedBy: "other" },
    { fingerprint: {} },
  ])
    await assert.rejects(caller.activate({ ...input, ...extra } as never), {
      code: "BAD_REQUEST",
    });
  delete ctx.req.session.account;
  await assert.rejects(caller.activate(input), { code: "UNAUTHORIZED" });
  assert.equal(seen.length, 1);
});
test("stale rule reviews return a redacted conflict", async () => {
  const caller = rulesRouter.createCaller(
    context({
      activation: {
        activate: async () => {
          throw new RuleRequestError("CONFLICT", "diagnostic wording changed");
        },
      },
    }),
  );
  await assert.rejects(
    caller.activate({ ruleId: "rule", receiptId: "receipt" }),
    {
      code: "CONFLICT",
      message: "Rule or evidence changed; refresh and review again",
    },
  );
});
