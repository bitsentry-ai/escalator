import test from "node:test";
import assert from "node:assert/strict";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
const old = Buffer.alloc(32, 1).toString("base64");
const next = Buffer.alloc(32, 2).toString("base64");
test("cookie signing keys are stable, purpose-separated and scoped to the workspace", () => {
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "old",
    keys: { old },
  });
  const first = keys.sessionSigningKeys("local");
  assert.equal(first.length, 1);
  assert.match(first[0], /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(keys.sessionSigningKeys("local"), first);
  assert.notDeepEqual(keys.sessionSigningKeys("other"), first);
  assert.notEqual(first[0], Buffer.from(old, "base64").toString("base64url"));
  assert.throws(() => keys.sessionSigningKeys(""));
});
test("key rotation signs with the active key while retaining old verification keys", () => {
  const before = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "old",
    keys: { old },
  }).sessionSigningKeys("local");
  const after = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "next",
    keys: { old, next },
  }).sessionSigningKeys("local");
  assert.equal(after.length, 2);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[0]);
});
