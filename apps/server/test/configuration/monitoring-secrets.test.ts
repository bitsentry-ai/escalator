import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  workspaceIdSchema,
  type Actor,
  type Role,
} from "@bitsentry-escalator/features/contracts";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { monitoringSecretsRouter } from "../../src/features/configuration/monitoring-secrets.router.js";
function fixture() {
  const state = { role: "administrator" as Role, fail: false };
  const req = {
    session: { account: { accountId: "owner", authVersion: 2 } },
  } as unknown as Request;
  const writes: {
    actor: Actor;
    name: string;
    value: Uint8Array;
    encoded: string;
  }[] = [];
  const context = {
    req,
    res: {} as Response,
    auth: {
      async current() {
        return { id: "owner", role: state.role };
      },
    },
    workspaceId: workspaceIdSchema.parse("local"),
    secretWriter: {
      async create(actor: Actor, name: string, value: Uint8Array) {
        writes.push({
          actor,
          name,
          value,
          encoded: new TextDecoder().decode(value),
        });
        if (state.fail) throw new Error("private provider detail");
        return { workspaceId: "local", id: "secret", name };
      },
      async list(actor: Actor) {
        assert.equal(actor.workspaceId, "local");
        return { items: [{ id: "secret", name: "Webhook" }], next: null };
      },
    },
  } as unknown as AppContext;
  return {
    state,
    req,
    writes,
    caller: monitoringSecretsRouter.createCaller(context),
  };
}
const input = {
  name: "Webhook",
  kind: "provider-signing" as const,
  credentials: { key: "fixture-signing-key" },
};
test("monitoring creation derives the local actor, exposes only metadata and erases owned bytes", async () => {
  const f = fixture();
  assert.deepEqual(await f.caller.create(input), {
    id: "secret",
    name: "Webhook",
  });
  assert.deepEqual(f.writes[0].actor, {
    workspaceId: "local",
    responderId: "owner",
    role: "administrator",
  });
  assert.equal(f.writes[0].encoded, input.credentials.key);
  assert.ok(f.writes[0].value.every((byte) => byte === 0));
  assert.deepEqual(await f.caller.list({}), {
    available: true,
    items: [{ id: "secret", name: "Webhook" }],
    next: null,
  });
  f.state.fail = true;
  await assert.rejects(f.caller.create(input), {
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to store monitoring credential",
  });
  assert.ok(f.writes[1].value.every((byte) => byte === 0));
});
test("monitoring creation rejects readers, scope injection and revoked sessions before the writer", async () => {
  const f = fixture();
  for (const role of ["viewer", "responder"] as const) {
    f.state.role = role;
    await assert.rejects(f.caller.create(input), { code: "FORBIDDEN" });
    await assert.rejects(f.caller.list({}), { code: "FORBIDDEN" });
  }
  f.state.role = "administrator";
  await assert.rejects(
    f.caller.create({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  delete f.req.session.account;
  await assert.rejects(f.caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(f.writes.length, 0);
});
