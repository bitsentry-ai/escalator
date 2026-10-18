import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  workspaceIdSchema,
  investigationViewSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { investigationReportsRouter } from "../../src/features/investigation/report.router.js";
function fixture() {
  const req = {
    session: { account: { accountId: "owner", authVersion: 1 } },
  } as unknown as Request;
  const calls: Array<{ actor: Actor; input: unknown }> = [];
  const state = { error: undefined as unknown };
  const view = investigationViewSchema.parse({
    scope: {
      workspaceId: "local",
      serviceId: "api",
      environmentId: "prod",
      incidentId: "incident_a",
    },
    observedAt: "2026-10-06T00:00:00.000Z",
    execution: "disabled",
    run: null,
  });
  const context = {
    req,
    res: {} as Response,
    workspaceId: workspaceIdSchema.parse("local"),
    auth: { current: async () => ({ id: "owner", role: "viewer" }) },
    investigationReports: {
      read: async (actor: Actor, input: unknown) => {
        calls.push({ actor, input });
        if (state.error) throw state.error;
        return view;
      },
    },
  } as unknown as AppContext;
  return {
    req,
    calls,
    state,
    view,
    caller: investigationReportsRouter.createCaller(context),
  };
}
test("report route derives identity from the session and rejects caller scope", async () => {
  const f = fixture();
  assert.deepEqual(await f.caller.get({ id: "incident_a" }), f.view);
  assert.deepEqual(f.calls, [
    {
      actor: { workspaceId: "local", responderId: "owner", role: "viewer" },
      input: { id: "incident_a" },
    },
  ]);
  await assert.rejects(
    f.caller.get({ id: "incident_a", workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  delete f.req.session.account;
  await assert.rejects(f.caller.get({ id: "incident_a" }), {
    code: "UNAUTHORIZED",
  });
  assert.equal(f.calls.length, 1);
});
test("report route maps denial and absence without leaking storage errors", async () => {
  const f = fixture();
  for (const [internal, code] of [
    ["forbidden", "FORBIDDEN"],
    ["not_found", "NOT_FOUND"],
  ]) {
    f.state.error = { code: internal, message: "private" };
    await assert.rejects(f.caller.get({ id: "incident_a" }), { code });
  }
  f.state.error = new Error("private credential or database message");
  await assert.rejects(f.caller.get({ id: "incident_a" }), {
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to read investigation report",
  });
});
