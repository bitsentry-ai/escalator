import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeModelSecret,
  modelCredentialSecrets,
} from "../src/investigation/models/credential-projection.js";
import {
  SecretAccessError,
  type SecretStore,
  type SecretUse,
} from "../src/application/ports/secrets.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
function fixture(
  bytes = encodeModelSecret({
    name: "Provider",
    credentials: { key: "test-key" },
  }),
) {
  const abort = new AbortController();
  const use: SecretUse = {
    workspaceId: workspaceIdSchema.parse("workspace_a"),
    secretId: "key_a",
    queue: "job",
    workId: "investigation_a",
    claimToken: "claim_a",
    signal: abort.signal,
  };
  const requests: SecretUse[] = [];
  const host: SecretStore = {
    withSecret: async (request, consume) => {
      requests.push(request);
      return consume(bytes);
    },
  };
  return { abort, use, requests, bytes, store: modelCredentialSecrets(host) };
}
test("model projection delegates the live claim unchanged and wipes only its owned key bytes", async () => {
  const f = fixture();
  const original = f.bytes.slice();
  let retained: Uint8Array | undefined;
  const value = await f.store.withSecret(f.use, async (key) => {
    retained = key;
    assert.equal(new TextDecoder().decode(key), "test-key");
    return "response";
  });
  assert.equal(value, "response");
  assert.equal(f.requests[0], f.use);
  assert.ok(retained!.every((n) => n === 0));
  assert.deepEqual(f.bytes, original);
});
test("projection wipes keys and hides provider exceptions containing credentials", async () => {
  const f = fixture();
  let retained: Uint8Array | undefined;
  await assert.rejects(
    f.store.withSecret(f.use, async (key) => {
      retained = key;
      throw new Error("test-key leaked by SDK");
    }),
    (error: unknown) =>
      error instanceof SecretAccessError && !error.message.includes("test-key"),
  );
  assert.ok(retained!.every((n) => n === 0));
});
test("model keys require a strict broker-compatible token bundle, not guessed fields or raw bytes", async () => {
  for (const text of [
    "raw-key",
    '{"value":"test-key"}',
    '{"token":"test-key","extra":true}',
    '{"token":"contains space"}',
    '{"token":""}',
    "null",
  ]) {
    const f = fixture(new TextEncoder().encode(text));
    let called = false;
    await assert.rejects(
      f.store.withSecret(f.use, async () => {
        called = true;
      }),
      SecretAccessError,
    );
    assert.equal(called, false);
  }
});
test("invalid UTF-8 and oversized credential bundles never reach a model", async () => {
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array(16417)]) {
    const f = fixture(bytes);
    await assert.rejects(
      f.store.withSecret(f.use, async () => assert.fail("model called")),
      SecretAccessError,
    );
  }
});
test("cancellation before and during projection prevents a successful result", async () => {
  const before = fixture();
  before.abort.abort();
  await assert.rejects(
    before.store.withSecret(before.use, async () =>
      assert.fail("model called"),
    ),
    SecretAccessError,
  );
  const during = fixture();
  let retained: Uint8Array | undefined;
  await assert.rejects(
    during.store.withSecret(during.use, async (bytes) => {
      retained = bytes;
      during.abort.abort();
      return "late";
    }),
    SecretAccessError,
  );
  assert.ok(retained!.every((n) => n === 0));
});
test("host denial is not replaced with a cached key or a fallback", async () => {
  const f = fixture();
  let called = false;
  const denied = modelCredentialSecrets({
    withSecret: async () => {
      throw new SecretAccessError();
    },
  });
  await assert.rejects(
    denied.withSecret(f.use, async () => {
      called = true;
    }),
    SecretAccessError,
  );
  assert.equal(called, false);
});
test("secret creation encodes only an explicitly named model credential", () => {
  const bytes = encodeModelSecret({
    name: "Provider",
    credentials: { key: "test-key" },
  });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
    token: "test-key",
  });
  for (const key of ["", "with space", "with\nnewline", "é", "x".repeat(8193)])
    assert.throws(() =>
      encodeModelSecret({ name: "Provider", credentials: { key } }),
    );
  assert.throws(() =>
    encodeModelSecret({
      name: "Provider",
      credentials: { key: "test", secretId: "injected" },
    } as never),
  );
});
