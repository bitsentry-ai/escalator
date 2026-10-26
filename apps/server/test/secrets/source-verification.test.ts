import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import {
  SignalIngressError,
  type SourceVerificationUse,
} from "@bitsentry-escalator/features/application";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { PostgresSourceVerificationSecrets } from "../../src/platform/secrets/source-verification.store.js";
function fixture() {
  const workspaceId = workspaceIdSchema.parse("workspace");
  const use: SourceVerificationUse = {
    workspaceId,
    sourceId: "source",
    sourceVersion: 1,
    grantId: "receiver",
    receiverHash: "a".repeat(64),
    secretId: "secret",
    signal: new AbortController().signal,
  };
  const at = "2026-10-02T00:00:00.000Z";
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 1).toString("base64") },
  });
  const row = {
    source: {
      id: use.sourceId,
      serviceId: "service",
      environmentId: "production",
      name: "Sentry",
      kind: "sentry",
      enabled: true,
      version: 1,
      grouping: "source-fingerprint",
      recovery: "manual",
      recoveryHoldSeconds: 60,
      authSecretId: use.secretId,
      intake: { mode: "sentry-hmac" },
      createdAt: at,
      updatedAt: at,
    },
    grant: {
      id: use.grantId,
      sourceId: use.sourceId,
      tokenHash: use.receiverHash,
      scope: "signal:write",
      createdAt: at,
      expiresAt: "2026-10-03T00:00:00.000Z",
      revokedAt: null as string | null,
    },
    secret_id: use.secretId,
    workspace_id: workspaceId,
    disabled_at: null as Date | null,
    service_enabled: true,
    envelope: keys.seal(
      { id: use.secretId, workspaceId },
      Buffer.from("verification-key"),
    ),
  };
  let missing = false;
  let now = new Date(at);
  let released = 0;
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return {
          rows: sql.startsWith("SELECT s.data")
            ? missing
              ? []
              : [row]
            : sql === "SELECT clock_timestamp() AS now"
              ? [{ now }]
              : [],
        };
      },
      release: () => {
        released++;
      },
    }),
  } as unknown as Pool;
  return {
    use,
    row,
    calls,
    store: new PostgresSourceVerificationSecrets(pool, keys),
    missing: () => {
      missing = true;
    },
    expire: () => {
      now = new Date("2026-10-03T00:00:00.000Z");
    },
    released: () => released,
  };
}
test("source verification requires scoped persisted authority and clears owned plaintext", async () => {
  const f = fixture();
  let owned: Uint8Array | undefined;
  const result = await f.store.withSecret(f.use, (bytes) => {
    owned = bytes;
    return Buffer.from(bytes).toString() === "verification-key";
  });
  assert.equal(result, true);
  assert.ok(owned?.every((value) => value === 0));
  const select = f.calls.find((call) => call.sql.startsWith("SELECT s.data"))!;
  assert.deepEqual(select.values, [
    f.use.workspaceId,
    f.use.sourceId,
    f.use.grantId,
    f.use.receiverHash,
    f.use.secretId,
  ]);
  assert.match(select.sql, /FOR SHARE OF s,g,k,v/);
  assert.ok(
    f.calls.findIndex(
      (call) => call.sql === "SELECT clock_timestamp() AS now",
    ) > f.calls.indexOf(select),
  );
  assert.equal(f.released(), 1);
});
test("missing, disabled, revoked and expired source claims never release a secret", async () => {
  for (const change of [
    "missing",
    "disabled",
    "revoked",
    "expired",
    "foreign",
    "version",
    "service",
  ] as const) {
    const f = fixture();
    if (change === "missing") f.missing();
    else if (change === "disabled") f.row.disabled_at = new Date();
    else if (change === "revoked")
      f.row.grant.revokedAt = "2026-10-02T00:00:00.000Z";
    else if (change === "expired") f.expire();
    else if (change === "foreign")
      f.row.workspace_id = workspaceIdSchema.parse("foreign");
    else if (change === "version") f.row.source.version = 2;
    else if (change === "service") f.row.service_enabled = false;
    let consumed = false;
    await assert.rejects(
      f.store.withSecret(f.use, () => {
        consumed = true;
      }),
      { code: "secret_unavailable" },
    );
    assert.equal(consumed, false);
    assert.equal(f.released(), 1);
  }
});
test("callback signature failures retain their safe classification while plaintext is erased", async () => {
  const f = fixture();
  let owned: Uint8Array | undefined;
  await assert.rejects(
    f.store.withSecret(f.use, (bytes) => {
      owned = bytes;
      throw new SignalIngressError("invalid_token");
    }),
    { code: "invalid_token" },
  );
  assert.ok(owned?.every((value) => value === 0));
});
