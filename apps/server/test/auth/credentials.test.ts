import test from "node:test";
import assert from "node:assert/strict";
import { generate } from "otplib";
import {
  PasswordHasher,
  issueToken,
  tokenDigest,
  newTotpEnrollment,
  verifyTotp,
} from "../../src/platform/auth/credentials.js";
import { persistedRegistrationSchema } from "../../src/platform/auth/schemas.js";

test("password adapter bounds concurrent work and preserves password whitespace", async () => {
  const passwords = new PasswordHasher(1);
  const pending = passwords.create("  synthetic-long-password  ");
  await assert.rejects(passwords.create("another-long-password"), {
    code: "authentication_failed",
  });
  const encoded = await pending;
  assert.equal(
    await passwords.matches(encoded, "  synthetic-long-password  "),
    true,
  );
  assert.equal(
    await passwords.matches(encoded, "synthetic-long-password"),
    false,
  );
  assert.equal(await passwords.matches("corrupt-hash", "password"), false);
  await assert.rejects(passwords.create("short"));
  await assert.rejects(passwords.create("🙂".repeat(6)));
  await assert.rejects(passwords.create("x".repeat(1025)));
});
test("one-use credentials have independently generated values and stable digests", () => {
  const a = issueToken();
  const b = issueToken();
  assert.equal(a.value.length, 43);
  assert.notEqual(a.value, b.value);
  assert.equal(a.digest, tokenDigest(a.value));
  assert.notEqual(a.value, a.digest);
});
test("TOTP adapter returns a consumable step and rejects replay or malformed input", async () => {
  const { secret, uri } = newTotpEnrollment("local-user");
  assert.ok(uri.startsWith("otpauth://totp/Escalator"));
  const epoch = 1800000000;
  const token = await generate({ secret, epoch });
  const step = await verifyTotp(secret, token, epoch);
  assert.equal(step, epoch / 30);
  assert.equal(await verifyTotp(secret, token, epoch, step), undefined);
  assert.equal(await verifyTotp(secret, "broken", epoch), undefined);
});
test("registration persistence input cannot supply scope or privilege", () => {
  const value = {
    tokenDigest: "a".repeat(64),
    login: "  Local-User  ",
    passwordHash: "fixture-hash",
    displayName: "Local user",
    timeZone: "UTC",
  };
  assert.equal(persistedRegistrationSchema.parse(value).login, "local-user");
  for (const extra of [
    { workspaceId: "other" },
    { role: "administrator" },
    { enabled: true },
  ])
    assert.equal(
      persistedRegistrationSchema.safeParse({ ...value, ...extra }).success,
      false,
    );
  assert.equal(
    persistedRegistrationSchema.safeParse({
      ...value,
      timeZone: "invalid/timezone",
    }).success,
    false,
  );
});
