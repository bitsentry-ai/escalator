import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { authRouter } from "../../src/platform/auth/auth.router.js";
import { AuthenticationError } from "../../src/platform/auth/credentials.js";
import { routerContext } from "../trpc/router-context.js";
function fixture() {
  const calls: string[] = [];
  const proof = { accountId: "owner", authVersion: 2 };
  const req = { ip: "127.0.0.1" } as Request;
  function session() {
    return {
      csrf: "a".repeat(43),
      save(done: (error?: Error) => void) {
        calls.push("save");
        done();
      },
      regenerate(done: (error?: Error) => void) {
        calls.push("regenerate");
        req.session = session();
        delete req.session.csrf;
        done();
      },
      destroy(done: (error?: Error) => void) {
        calls.push("destroy");
        done();
      },
    } as unknown as Request["session"];
  }
  req.session = session();
  const auth = {
    async initializeSession(ip: string) {
      calls.push(`initialize:${ip}`);
    },
    async current() {
      return {
        id: "owner",
        login: "owner",
        role: "administrator",
        displayName: "Owner",
        timeZone: "UTC",
        passwordHash: "private-password-hash",
        totpSecretId: "private-secret-id",
      };
    },
    async login() {
      calls.push("login");
      return proof;
    },
    async register() {
      calls.push("register");
    },
    async invite() {
      return "i".repeat(43);
    },
    async beginTotp() {
      return { uri: "otpauth://fixture" };
    },
    async enableTotp() {
      return { proof, recoveryCodes: ["one-use"] };
    },
    async disableTotp() {
      return proof;
    },
    async recover() {
      calls.push("recover");
    },
  };
  const context = routerContext({ req, auth });
  return {
    calls,
    req,
    auth,
    caller: authRouter.createCaller(context),
  };
}
test("public session exposes only profile fields and never credential material", async () => {
  const f = fixture();
  f.req.session.account = { accountId: "owner", authVersion: 2 };
  const response = await f.caller.session();
  assert.deepEqual(response.user, {
    id: "owner",
    login: "owner",
    role: "administrator",
    displayName: "Owner",
    timeZone: "UTC",
    totpEnabled: true,
  });
  assert.equal(JSON.stringify(response).includes("private-"), false);
  assert.ok(f.calls.includes("save"));
});
test("revoked sessions become anonymous and receive a usable CSRF token", async () => {
  const f = fixture();
  f.req.session.account = { accountId: "owner", authVersion: 1 };
  f.auth.current = async () => {
    throw new AuthenticationError();
  };
  const response = await f.caller.session();
  assert.equal(response.user, null);
  assert.match(response.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.req.session.account, undefined);
  assert.deepEqual(f.calls, ["regenerate", "initialize:127.0.0.1", "save"]);
});
test("login rotates session and registration rejects scope and role injection", async () => {
  const f = fixture();
  const response = await f.caller.login({
    login: "owner",
    password: "password",
  });
  assert.notEqual(response.csrf, "a".repeat(43));
  assert.deepEqual(f.calls, ["login", "regenerate", "save"]);
  const input = {
    token: "t".repeat(43),
    login: "reader",
    password: "long password",
    displayName: "Reader",
    timeZone: "UTC",
    workspaceId: "attacker",
    role: "administrator",
  };
  await assert.rejects(f.caller.register(input));
  assert.ok(!f.calls.includes("register"));
});
test("MFA routes require session proof; enabling rotates the session before returning codes", async () => {
  const f = fixture();
  await assert.rejects(f.caller.beginTotp({ password: "password" }), {
    code: "UNAUTHORIZED",
  });
  f.req.session.account = { accountId: "owner", authVersion: 1 };
  const response = await f.caller.enableTotp({ token: "123456" });
  assert.deepEqual(response.recoveryCodes, ["one-use"]);
  assert.equal(f.req.session.account.authVersion, 2);
  assert.deepEqual(f.calls, ["regenerate", "save"]);
});
test("operator recovery destroys the current session and requires a fresh login", async () => {
  const f = fixture();
  await f.caller.recover({ token: "r".repeat(43), password: "long password" });
  assert.deepEqual(f.calls, ["recover", "destroy"]);
});
