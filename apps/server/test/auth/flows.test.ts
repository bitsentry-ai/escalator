import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalAuthService,
  type AuthAccounts,
  type AccountSecurity,
  type PasswordWork,
} from "../../src/platform/auth/auth.service.js";
import {
  AuthenticationError,
  tokenDigest,
} from "../../src/platform/auth/credentials.js";
import type { AccountRecord } from "../../src/platform/auth/auth.repository.js";
function fixture() {
  const account: AccountRecord = {
    id: "owner",
    login: "owner",
    passwordHash: "hash",
    enabled: true,
    authVersion: 1,
    role: "administrator",
    displayName: "Owner",
    timeZone: "UTC",
    totpSecretId: null,
    totpPendingSecretId: null,
    totpPendingExpiresAt: null,
    totpLastStep: null,
  };
  const calls: string[] = [];
  let visible = true;
  const accounts: AuthAccounts = {
    async findByLogin() {
      return visible ? { ...account } : undefined;
    },
    async findById() {
      return visible ? { ...account } : undefined;
    },
    async register(input) {
      calls.push(`register:${input.tokenDigest}:${input.passwordHash}`);
      return "owner";
    },
    async invite(proof, digest, role, expiresAt) {
      calls.push(
        `invite:${proof.authVersion}:${digest}:${role}:${expiresAt.getTime()}`,
      );
      return "invitation";
    },
    async takeRateSlot(digest, max) {
      calls.push(`rate:${digest}:${max}`);
      return true;
    },
  };
  const security: AccountSecurity = {
    async authenticate(proof, factor) {
      calls.push(`authenticate:${factor}`);
      if (proof.authVersion !== account.authVersion)
        throw new AuthenticationError();
      return proof;
    },
    async beginTotp() {
      calls.push("begin");
      return { uri: "otpauth://fixture" };
    },
    async enableTotp(proof, token) {
      calls.push(`enable:${token}`);
      return {
        proof: { ...proof, authVersion: 2 },
        recoveryCodes: ["one-use"],
      };
    },
    async disableTotp(proof, factor) {
      calls.push(`disable:${factor}`);
      return { ...proof, authVersion: 2 };
    },
    async recover(digest, hash) {
      calls.push(`recover:${digest}:${hash}`);
    },
  };
  const passwords: PasswordWork = {
    async create(password) {
      calls.push(`hash:${password}`);
      return "new-hash";
    },
    async matches(hash, password) {
      calls.push(`verify:${hash}`);
      return password === "correct";
    },
  };
  const service = new LocalAuthService(
    accounts,
    security,
    passwords,
    "dummy-hash",
    () => 1000,
  );
  return {
    account,
    calls,
    accounts,
    security,
    passwords,
    service,
    hide() {
      visible = false;
    },
  };
}
const proof = { accountId: "owner", authVersion: 1 };
test("login limits IP first, normalizes identity, verifies password and passes MFA to atomic persistence", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.service.login("127.0.0.1", {
      login: " OWNER ",
      password: "correct",
      factor: "123456",
    }),
    proof,
  );
  assert.deepEqual(f.calls, [
    `rate:${tokenDigest("ip:127.0.0.1")}:30`,
    `rate:${tokenDigest("subject:login:owner")}:10`,
    "verify:hash",
    "authenticate:123456",
  ]);
});
test("unknown accounts perform dummy verification and never authenticate", async () => {
  const f = fixture();
  f.hide();
  await assert.rejects(
    f.service.login("local", { login: "missing", password: "correct" }),
    { code: "authentication_failed" },
  );
  assert.ok(f.calls.includes("verify:dummy-hash"));
  assert.ok(!f.calls.some((c) => c.startsWith("authenticate")));
});
test("rate rejection happens before account lookup or password work", async () => {
  const f = fixture();
  let attempts = 0;
  f.accounts.takeRateSlot = async () => {
    attempts++;
    return false;
  };
  f.accounts.findByLogin = async () => {
    assert.fail("must not query account");
  };
  await assert.rejects(
    f.service.login("local", { login: "owner", password: "correct" }),
    { code: "authentication_failed" },
  );
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 0);
});
test("password verification races cannot bypass the persisted account version", async () => {
  const f = fixture();
  f.passwords.matches = async () => {
    f.account.authVersion++;
    return true;
  };
  await assert.rejects(
    f.service.login("local", { login: "owner", password: "correct" }),
    { code: "authentication_failed" },
  );
  await assert.rejects(f.service.current(proof), {
    code: "authentication_failed",
  });
});
test("registration hashes passwords and tokens without starting a session", async () => {
  const f = fixture();
  await f.service.register("local", {
    token: "invitation",
    login: "reader",
    password: "long password",
    displayName: "Reader",
    timeZone: "UTC",
  });
  assert.ok(f.calls.includes(`register:${tokenDigest("invitation")}:new-hash`));
  assert.ok(!f.calls.some((c) => c.startsWith("authenticate")));
});
test("invitations require a current administrator and return only the raw one-use token", async () => {
  const f = fixture();
  const raw = await f.service.invite("local", proof, "viewer");
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(f.calls.includes(`invite:1:${tokenDigest(raw)}:viewer:86401000`));
  f.account.role = "viewer";
  await assert.rejects(f.service.invite("local", proof, "administrator"), {
    code: "authentication_failed",
  });
});
test("MFA changes require current session and password; confirmation returns recovery codes once", async () => {
  const f = fixture();
  await assert.rejects(f.service.beginTotp("local", proof, "wrong"), {
    code: "authentication_failed",
  });
  assert.ok(!f.calls.includes("begin"));
  assert.deepEqual(await f.service.beginTotp("local", proof, "correct"), {
    uri: "otpauth://fixture",
  });
  assert.deepEqual(await f.service.enableTotp("local", proof, "123456"), {
    proof: { ...proof, authVersion: 2 },
    recoveryCodes: ["one-use"],
  });
  assert.deepEqual(
    await f.service.disableTotp("local", proof, "correct", "recovery-code"),
    { ...proof, authVersion: 2 },
  );
  f.account.enabled = false;
  await assert.rejects(f.service.enableTotp("local", proof, "123456"), {
    code: "authentication_failed",
  });
});
test("operator recovery hashes both credentials and leaves session creation to fresh login", async () => {
  const f = fixture();
  await f.service.recover("local", "recovery-grant", "new password");
  assert.ok(
    f.calls.includes(`recover:${tokenDigest("recovery-grant")}:new-hash`),
  );
  assert.ok(!f.calls.some((c) => c.startsWith("authenticate")));
});
