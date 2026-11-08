import test from "node:test";
import assert from "node:assert/strict";
import type { Role } from "@bitsentry-escalator/features/contracts";
import { channelSecretsRouter } from "../../src/features/configuration/channel-secrets.router.js";
import { routerContext, sessionActor } from "../trpc/router-context.js";
function fixture(role: Role = "administrator", fail = false) {
  let bytes: Uint8Array | undefined;
  let calls = 0;
  const context = routerContext(
    {
      secretWriter: {
        create: async (
          actor: unknown,
          name: string,
          value: Uint8Array,
          channel: string,
        ) => {
          assert.deepEqual(actor, sessionActor());
          assert.deepEqual(JSON.parse(Buffer.from(value).toString()), {
            url: "https://example.com/page",
          });
          assert.equal(channel, "webhook");
          bytes = value;
          calls++;
          if (fail) throw new Error("storage unavailable");
          return { workspaceId: "local", id: "opaque", name };
        },
        list: async () => ({
          items: [{ id: "opaque", name: "Operations", channel: "webhook" }],
          next: null,
        }),
      },
    },
    { role },
  );
  return {
    caller: channelSecretsRouter.createCaller(context),
    bytes: () => bytes,
    calls: () => calls,
  };
}
const input = {
  channel: "webhook" as const,
  name: "Operations",
  credentials: { url: "https://example.com/page" },
};
test("credential creation returns metadata only and clears its owned plaintext buffer", async () => {
  const value = fixture();
  assert.deepEqual(await value.caller.create(input), {
    id: "opaque",
    name: "Operations",
    channel: "webhook",
  });
  assert.ok(value.bytes()?.every((byte) => byte === 0));
  assert.deepEqual(await value.caller.list({}), {
    available: true,
    items: [{ id: "opaque", name: "Operations", channel: "webhook" }],
    next: null,
  });
});
test("credential settings reject non-administrators and non-HTTPS webhook destinations", async () => {
  const viewer = fixture("viewer");
  await assert.rejects(viewer.caller.create(input), { code: "FORBIDDEN" });
  await assert.rejects(viewer.caller.list({}), { code: "FORBIDDEN" });
  assert.equal(viewer.calls(), 0);
  const admin = fixture();
  await assert.rejects(
    admin.caller.create({
      ...input,
      credentials: { url: "http://example.com" },
    }),
    { code: "BAD_REQUEST" },
  );
  assert.equal(admin.calls(), 0);
});

test("failed credential writes still clear their owned buffer", async () => {
  const value = fixture("administrator", true);
  await assert.rejects(value.caller.create(input), {
    code: "INTERNAL_SERVER_ERROR",
  });
  assert.ok(value.bytes()?.every((byte) => byte === 0));
});
