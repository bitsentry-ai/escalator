import type { PostgresSecretWriter } from "../../src/platform/secrets/postgres-secret.writer.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { resolveResponse } from "@trpc/server/http";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { authRouter } from "../../src/platform/auth/auth.router.js";
import { appRouter } from "../../src/platform/trpc/router.js";
import type { LocalAuthService } from "../../src/platform/auth/auth.service.js";
import { AuthenticationError } from "../../src/platform/auth/credentials.js";
import type {
  ConfigurationUseCases,
  IncidentUseCases,
  ServiceUseCases,
} from "@bitsentry-escalator/features/application";
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
  const context = {
    incidents: {} as IncidentUseCases,
    secretWriter: {} as PostgresSecretWriter,
    configuration: {} as ConfigurationUseCases,
    services: {} as ServiceUseCases,
    req,
    res: {} as Response,
    auth: auth as unknown as LocalAuthService,
    workspaceId: workspaceIdSchema.parse("local"),
  };
  return {
    calls,
    req,
    auth,
    context,
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
test("HTTP tRPC errors redact database messages and stack traces without a listener", async () => {
  const f = fixture();
  f.auth.login = async () => {
    throw new Error("sensitive-database-connection-material");
  };
  const response = await resolveResponse({
    router: appRouter,
    path: "auth.login",
    req: new globalThis.Request("https://escalator.example/trpc/auth.login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "owner", password: "password" }),
    }),
    createContext: async () => f.context,
    error: null,
  });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.equal(body.includes("sensitive-database"), false);
  assert.equal(body.includes("stack"), false);
  assert.ok(body.includes("Request failed"));
});
