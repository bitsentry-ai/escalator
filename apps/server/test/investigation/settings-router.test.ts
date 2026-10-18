import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  type Actor,
  type Role,
} from "@bitsentry-escalator/features/contracts";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { investigationSettingsRouter } from "../../src/features/investigation/settings.router.js";
function fixture() {
  const state = { role: "administrator" as Role, error: undefined as unknown };
  const req = {
    session: { account: { accountId: "owner", authVersion: 1 } },
  } as unknown as Request;
  const calls: Array<{ actor: Actor; input: unknown }> = [];
  const writes: Array<{ bytes: Uint8Array; encoded: string; actor: Actor }> =
    [];
  const run = async (actor: Actor, input: unknown) => {
    calls.push({ actor, input });
    if (state.error) throw state.error;
    return { saved: true };
  };
  const context = {
    req,
    res: {} as Response,
    workspaceId: workspaceIdSchema.parse("local"),
    auth: { current: async () => ({ id: "owner", role: state.role }) },
    investigationSettings: { get: run, create: run, update: run },
    secretWriter: {
      create: async (actor: Actor, name: string, bytes: Uint8Array) => {
        writes.push({ actor, bytes, encoded: new TextDecoder().decode(bytes) });
        if (state.error) throw state.error;
        return { id: "key_a", name };
      },
    },
  } as unknown as AppContext;
  return {
    state,
    req,
    calls,
    writes,
    caller: investigationSettingsRouter.createCaller(context),
  };
}
const input = {
  serviceId: serviceIdSchema.parse("service"),
  environmentId: environmentIdSchema.parse("production"),
  enabled: false,
  destination: {
    provider: "ollama" as const,
    model: "local",
    location: "local" as const,
    origin: "http://127.0.0.1:11434",
  },
  endpoint: "http://127.0.0.1:11434",
  secretId: null,
  limits: {
    maxDurationMs: 60000,
    maxModelCalls: 1,
    maxEvidenceReads: 4,
    maxEvidenceBytes: 32768,
    maxOutputTokens: 1024,
    maxTraceEvents: 32,
  },
  sources: [],
};
test("settings routes derive the actor from the local session and reject body scope", async () => {
  const f = fixture();
  await f.caller.get({
    serviceId: input.serviceId,
    environmentId: input.environmentId,
  });
  await f.caller.create(input);
  assert.deepEqual(f.calls[0].actor, {
    workspaceId: "local",
    responderId: "owner",
    role: "administrator",
  });
  await assert.rejects(
    f.caller.create({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  assert.equal(f.calls.length, 2);
  delete f.req.session.account;
  await assert.rejects(f.caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(f.calls.length, 2);
});
test("settings routes preserve typed conflicts and hide internal failure details", async () => {
  const f = fixture();
  f.state.error = { code: "conflict" };
  await assert.rejects(f.caller.create(input), { code: "CONFLICT" });
  f.state.error = { code: "not_found" };
  await assert.rejects(f.caller.create(input), { code: "NOT_FOUND" });
  f.state.error = { code: "forbidden" };
  await assert.rejects(f.caller.create(input), { code: "FORBIDDEN" });
  f.state.error = new Error("private-credential");
  await assert.rejects(
    f.caller.create(input),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("private-credential"),
  );
});
test("model credential creation stores the canonical bundle and erases owned bytes", async () => {
  const f = fixture();
  const secret = { name: "Model", credentials: { key: "test-key" } };
  assert.deepEqual(await f.caller.createSecret(secret), {
    id: "key_a",
    name: "Model",
  });
  assert.deepEqual(JSON.parse(f.writes[0].encoded), { token: "test-key" });
  assert.equal(f.writes[0].actor.workspaceId, "local");
  assert.ok(f.writes[0].bytes.every((x) => x === 0));
  f.state.error = new Error("test-key");
  await assert.rejects(f.caller.createSecret(secret), {
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to store model credential",
  });
  assert.ok(f.writes[1].bytes.every((x) => x === 0));
});
test("only secret administrators can create model credentials", async () => {
  const f = fixture();
  for (const role of ["responder", "viewer"] as const) {
    f.state.role = role;
    await assert.rejects(
      f.caller.createSecret({
        name: "Model",
        credentials: { key: "test-key" },
      }),
      { code: "FORBIDDEN" },
    );
  }
  assert.equal(f.writes.length, 0);
});
test("source catalog routes reject untrusted workspace parameters before querying", async () => {
  const f = fixture();
  await assert.rejects(
    f.caller.sources({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      kind: "alert",
      workspaceId: "other",
    } as never),
    { code: "BAD_REQUEST" },
  );
});
