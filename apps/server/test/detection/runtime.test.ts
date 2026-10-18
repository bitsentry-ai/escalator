import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { standalonePagingRuntime } from "../../src/features/paging/runtime.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
test("standalone monitoring construction and shutdown do not open database connections", async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections++;
      throw new Error("unexpected connection");
    },
  } as unknown as Pool;
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 1).toString("base64") },
  });
  const { runtime } = standalonePagingRuntime(
    pool,
    workspaceIdSchema.parse("local"),
    keys,
    "https://example.test",
    () => {},
  );
  await runtime.onModuleDestroy();
  assert.equal(connections, 0);
});
