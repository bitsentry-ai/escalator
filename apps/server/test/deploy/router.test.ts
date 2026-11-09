import test from "node:test";
import assert from "node:assert/strict";
import { deploymentsRouter } from "../../src/features/deploy/deploy.router.js";
import { routerContext, sessionActor } from "../trpc/router-context.js";
test("deployment target creation enables the target by default", async () => {
  const seen: unknown[] = [];
  const caller = deploymentsRouter.createCaller(
    routerContext({
      deployments: {
        create: async (actor: unknown, input: unknown) => {
          seen.push([actor, input]);
          return { id: "target" };
        },
      },
    }),
  );
  const input = {
    name: "API",
    serviceId: "api",
    environmentId: "prod",
    policyId: "policy",
    timeoutSeconds: 600,
  };
  await caller.create(input);
  assert.deepEqual(seen, [[sessionActor(), { ...input, enabled: true }]]);
});

test("coverage procedures pass trusted actors and reject a blank override reason", async () => {
  const seen: unknown[] = [];
  const record = async (actor: unknown, input: unknown) => {
    seen.push([actor, input]);
    return {};
  };
  const caller = deploymentsRouter.createCaller(
    routerContext({ deploymentPreflight: { get: record, override: record } }),
  );
  const query = { targetId: "target", decisionId: "decision" };
  const request = { ...query, key: "override", reason: "Emergency coverage" };
  await caller.coverage(query);
  await caller.overrideCoverage(request);
  assert.deepEqual(seen, [
    [sessionActor(), query],
    [sessionActor(), request],
  ]);
  await assert.rejects(caller.overrideCoverage({ ...request, reason: "   " }), {
    code: "BAD_REQUEST",
  });
  assert.equal(seen.length, 2);
});

test("deployment history defaults its page size", async () => {
  const seen: unknown[] = [];
  const caller = deploymentsRouter.createCaller(
    routerContext({
      deploymentQueries: {
        history: async (actor: unknown, input: unknown) => {
          seen.push([actor, input]);
          return { items: [], next: null };
        },
      },
    }),
  );
  await caller.history({ targetId: "target" });
  assert.deepEqual(seen, [[sessionActor(), { targetId: "target", limit: 25 }]]);
});
