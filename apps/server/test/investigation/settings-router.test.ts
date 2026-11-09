import test from "node:test";
import assert from "node:assert/strict";
import type { Actor, Role } from "@bitsentry-escalator/features/contracts";
import { investigationSettingsRouter } from "../../src/features/investigation/settings.router.js";
import { routerContext } from "../trpc/router-context.js";
function fixture() {
  const state = { role: "administrator" as Role, error: undefined as unknown };
  const writes: Array<{ bytes: Uint8Array; encoded: string; actor: Actor }> =
    [];
  const context = routerContext({
    auth: { current: async () => ({ id: "owner", role: state.role }) },
    secretWriter: {
      create: async (actor: Actor, name: string, bytes: Uint8Array) => {
        writes.push({ actor, bytes, encoded: new TextDecoder().decode(bytes) });
        if (state.error) throw state.error;
        return { id: "key_a", name };
      },
    },
  });
  return {
    state,
    writes,
    caller: investigationSettingsRouter.createCaller(context),
  };
}
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
