import test from "node:test";
import assert from "node:assert/strict";
import { labelsRouter } from "../../src/features/labels/labels.router.js";
import { routerContext, sessionActor } from "../trpc/router-context.js";
test("label list parses incident filtering and the default page size", async () => {
  const seen: unknown[] = [];
  const caller = labelsRouter.createCaller(
    routerContext(
      {
        labels: {
          list: async (actor: unknown, input: unknown) => {
            seen.push([actor, input]);
            return { items: [], next: null };
          },
        },
      },
      { id: "reviewer", role: "responder" },
    ),
  );
  const query = {
    serviceId: "api",
    environmentId: "prod",
    incidentId: "incident",
  };
  await caller.list(query as never);
  assert.deepEqual(seen, [
    [sessionActor("reviewer", "responder"), { ...query, limit: 50 }],
  ]);
});
