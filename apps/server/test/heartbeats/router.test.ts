import test from "node:test";
import assert from "node:assert/strict";
import { heartbeatsRouter } from "../../src/features/heartbeats/heartbeats.router.js";
import { routerContext, sessionActor } from "../trpc/router-context.js";
test("heartbeat creation fills the schedule defaults before the use case", async () => {
  const calls: unknown[] = [];
  const caller = heartbeatsRouter.createCaller(
    routerContext({
      heartbeats: {
        create: async (actor: unknown, input: unknown) => {
          calls.push([actor, input]);
          return { id: "heartbeat" };
        },
      },
    }),
  );
  const input = { name: "Cron", serviceId: "api", environmentId: "prod" };
  await caller.create(input);
  assert.deepEqual(calls, [
    [
      sessionActor(),
      { ...input, enabled: false, intervalSeconds: 60, graceSeconds: 10 },
    ],
  ]);
});
