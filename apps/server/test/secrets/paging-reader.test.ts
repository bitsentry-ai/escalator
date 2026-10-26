import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { secretFixtureSeed } from "@escalator-test/secrets";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { EncryptedSecretStore } from "../../src/platform/secrets/encrypted-secret.store.js";
import { PostgresSecretReader } from "../../src/platform/secrets/postgres-secret.reader.js";
test("reader authorizes paging payloads from persisted rows before releasing bytes", async () => {
  const seed = secretFixtureSeed();
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 1).toString("base64") },
  });
  const identity = {
    workspaceId: seed.request.workspaceId,
    id: seed.request.secretId,
  };
  let payload: unknown = {
    secretId: identity.id,
    approvedSecretIds: [identity.id],
  };
  const envelope = keys.seal(identity, Buffer.from("fixture-value"));
  const pool = {
    connect: async () => ({
      query: async (sql: string) => ({
        rows: sql.startsWith("SELECT s.id")
          ? [
              {
                id: identity.id,
                workspace_id: identity.workspaceId,
                envelope,
                disabled_at: null,
                work_id: seed.request.workId,
                state: "running",
                lease_token: seed.request.claimToken,
                lease_expires_at: new Date(seed.claim.expiresAt!),
                database_now: new Date(seed.claim.databaseNow),
                work_kind: "paging.send",
                work_payload: payload,
              },
            ]
          : [],
      }),
      release() {},
    }),
  } as unknown as Pool;
  const store = new EncryptedSecretStore(keys, new PostgresSecretReader(pool));
  const request = { ...seed.request, queue: "outbox" as const };
  assert.equal(
    await store.withSecret(request, async (bytes) =>
      Buffer.from(bytes).toString(),
    ),
    "fixture-value",
  );
  let invoked = false;
  const markInvoked = async () => {
    invoked = true;
  };
  for (const denied of [
    { secretIds: [identity.id] },
    { secretId: "other", approvedSecretIds: [identity.id] },
  ]) {
    payload = denied;
    await assert.rejects(store.withSecret(request, markInvoked), /unavailable/);
  }
  assert.equal(invoked, false);
});
