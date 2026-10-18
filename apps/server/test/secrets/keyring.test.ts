import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import {
  SecretKeysModule,
  loadSecretKeys,
} from "../../src/platform/secrets/secrets.module.js";
import { AppModule } from "../../src/app.module.js";
const identity = { workspaceId: "org_a", id: "secret_a" };
const oldKey = Buffer.alloc(32, 11).toString("base64");
const newKey = Buffer.alloc(32, 22).toString("base64");
const oldRing = () =>
  SecretKeyRing.parse({
    version: 1,
    activeKeyId: "old",
    keys: { old: oldKey },
  });
test("rotation preserves old ciphertext and makes new writes use the active key", () => {
  const bytes = Buffer.from("private fixture value");
  const before = oldRing().seal(identity, bytes);
  const rotated = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "new",
    keys: { old: oldKey, new: newKey },
  });
  assert.deepEqual(rotated.open(identity, before), bytes);
  const after = rotated.seal(identity, bytes);
  assert.equal(after.keyId, "new");
  assert.deepEqual(rotated.open(identity, after), bytes);
  assert.throws(() => oldRing().open(identity, after), /unavailable/);
  assert.equal(JSON.stringify(after).includes(bytes.toString()), false);
});
test("scope, identity, key identifier, ciphertext and authentication tag cannot be substituted", () => {
  const ring = oldRing();
  const envelope = ring.seal(identity, Buffer.from("value"));
  for (const changed of [
    { ...identity, workspaceId: "org_b" },
    { ...identity, id: "secret_b" },
  ])
    assert.throws(() => ring.open(changed, envelope), /authentication/);
  for (const field of ["ciphertext", "nonce", "tag"] as const) {
    const bytes = Buffer.from(envelope[field], "base64");
    bytes[0] ^= 1;
    assert.throws(
      () =>
        ring.open(identity, { ...envelope, [field]: bytes.toString("base64") }),
      /authentication/,
    );
  }
  const aliases = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "old",
    keys: { old: oldKey, alias: oldKey },
  });
  assert.throws(
    () => aliases.open(identity, { ...envelope, keyId: "alias" }),
    /authentication/,
  );
  assert.notEqual(
    ring.seal(identity, Buffer.from("value")).nonce,
    envelope.nonce,
  );
});
test("startup rejects a missing key or malformed mounted key without exposing its content", () => {
  assert.throws(
    () => SecretKeyRing.fromFile(undefined),
    /ESCALATOR_SECRET_KEY_FILE/,
  );
  assert.throws(
    () =>
      SecretKeyRing.parse({
        version: 1,
        activeKeyId: "missing",
        keys: { old: oldKey },
      }),
    /configuration/,
  );
  const dir = mkdtempSync(join(tmpdir(), "escalator-key-test-"));
  const file = join(dir, "key.json");
  try {
    writeFileSync(file, `{"private-key-material":"${oldKey}",broken}`, {
      mode: 0o600,
    });
    assert.throws(
      () => SecretKeyRing.fromFile(file),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes(oldKey) &&
        /ESCALATOR_SECRET_KEY_FILE/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the host registers its key provider and rejects unconfigured startup", () => {
  const imports = Reflect.getMetadata("imports", AppModule) as unknown[];
  assert.ok(imports.includes(SecretKeysModule));
  assert.throws(() => loadSecretKeys({}), /ESCALATOR_SECRET_KEY_FILE/);
});
