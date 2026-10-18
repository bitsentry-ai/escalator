import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  workspaceIdSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type { SignalManagement } from "@bitsentry-escalator/features/application";
import type { LocalAuthService } from "../../src/platform/auth/auth.service.js";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { signalsRouter } from "../../src/features/signals/signals.router.js";
function fixture() {
  const req = {
    session: { account: { accountId: "owner", authVersion: 2 } },
  } as unknown as Request;
  const actors: Actor[] = [];
  const auth = {
    async current() {
      return { id: "owner", role: "administrator" };
    },
  };
  const signals = {
    async list(actor: Actor) {
      actors.push(actor);
      return { items: [], next: null };
    },
    async create(actor: Actor) {
      actors.push(actor);
      return { id: "source" };
    },
    async issueToken(actor: Actor) {
      actors.push(actor);
      throw Object.assign(new Error("private"), { code: "source_disabled" });
    },
    async revokeToken(actor: Actor) {
      actors.push(actor);
      throw Object.assign(new Error("private"), { code: "not_found" });
    },
  };
  const context = {
    req,
    res: {} as Response,
    auth: auth as unknown as LocalAuthService,
    signals: signals as unknown as SignalManagement,
    workspaceId: workspaceIdSchema.parse("local"),
  } as AppContext;
  return { req, actors, auth, caller: signalsRouter.createCaller(context) };
}
test("signal administration requires a current local session and derives its actor", async () => {
  const f = fixture();
  await f.caller.list({});
  assert.deepEqual(f.actors, [
    { workspaceId: "local", responderId: "owner", role: "administrator" },
  ]);
  delete f.req.session.account;
  await assert.rejects(f.caller.list({}), { code: "UNAUTHORIZED" });
  assert.equal(f.actors.length, 1);
});
test("signal administration rejects client scope before invoking the use case", async () => {
  const f = fixture();
  await assert.rejects(
    f.caller.create({
      name: "Errors",
      kind: "generic",
      serviceId: "service",
      environmentId: "production",
      workspaceId: "foreign",
    } as never),
    { code: "BAD_REQUEST" },
  );
  await assert.rejects(
    f.caller.issueToken({
      sourceId: "source",
      workspaceId: "foreign",
    } as never),
    { code: "BAD_REQUEST" },
  );
  assert.equal(f.actors.length, 0);
});
test("disabled sources, missing grants and revoked sessions have safe application errors", async () => {
  const f = fixture();
  await assert.rejects(f.caller.issueToken({ sourceId: "source" }), {
    code: "PRECONDITION_FAILED",
    message: "Source cannot accept ingestion grants",
  });
  await assert.rejects(f.caller.revokeToken({ id: "foreign" }), {
    code: "NOT_FOUND",
  });
  f.auth.current = async () => {
    throw Object.assign(new Error("private"), {
      code: "authentication_failed",
    });
  };
  await assert.rejects(f.caller.list({}), { code: "UNAUTHORIZED" });
  assert.equal(f.actors.length, 2);
});
