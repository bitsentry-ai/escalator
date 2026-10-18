import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { detectionRouter } from "../../src/features/detection/detection.router.js";
test("binding APIs require current local identity and reject caller-selected scope", async () => {
  const actors: unknown[] = [];
  const context = {
    workspaceId: "local",
    req: { session: { account: { accountId: "owner", authVersion: 1 } } },
    auth: { current: async () => ({ id: "owner", role: "administrator" }) },
    detection: {
      get: async (actor: unknown) => {
        actors.push(actor);
        return undefined;
      },
      configure: async (actor: unknown) => {
        actors.push(actor);
        return { id: "binding" };
      },
    },
  } as unknown as AppContext;
  const caller = detectionRouter.createCaller(context);
  const input = {
    serviceId: "api",
    environmentId: "prod",
    expectedVersion: null,
    enabled: false,
    policyId: null,
  };
  await caller.configureBinding(input);
  await caller.getBinding({ serviceId: "api", environmentId: "prod" });
  assert.deepEqual(actors, [
    { workspaceId: "local", responderId: "owner", role: "administrator" },
    { workspaceId: "local", responderId: "owner", role: "administrator" },
  ]);
  await assert.rejects(
    caller.configureBinding({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  delete context.req.session.account;
  await assert.rejects(caller.configureBinding(input), {
    code: "UNAUTHORIZED",
  });
  assert.equal(actors.length, 2);
});
