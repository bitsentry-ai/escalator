import test from "node:test";
import assert from "node:assert/strict";
import { argon2id, hash, verify } from "argon2";
import { generateSecret, generate, verify as verifyOtp } from "otplib";
import session from "express-session";

test("CommonJS host loads native Argon2id and verifies the exact password", async () => {
  const password = "  synthetic-password-for-review  ";
  const encoded = await hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await verify(encoded, password), true);
  assert.equal(await verify(encoded, password.trim()), false);
});
test("TOTP library exposes the matched step for persisted replay prevention", async () => {
  const secret = generateSecret({ length: 20 });
  const epoch = 1800000000;
  const token = await generate({
    secret,
    epoch,
    algorithm: "sha1",
    digits: 6,
    period: 30,
  });
  const result = await verifyOtp({
    secret,
    token,
    epoch,
    strategy: "totp",
    algorithm: "sha1",
    digits: 6,
    period: 30,
  });
  assert.equal(result.valid, true);
  assert.ok("timeStep" in result);
  assert.equal(result.timeStep, epoch / 30);
  const replay = await verifyOtp({
    secret,
    token,
    epoch,
    strategy: "totp",
    afterTimeStep: result.timeStep,
  });
  assert.equal(replay.valid, false);
});
test("CommonJS session library supports a host persistence adapter without a listener", () => {
  assert.equal(typeof session, "function");
  assert.equal(typeof session.Store.prototype.regenerate, "function");
  assert.equal(typeof session.Session.prototype.regenerate, "function");
});
