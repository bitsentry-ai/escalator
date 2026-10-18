import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import session from "express-session";
import {
  cookieOriginGuard,
  csrfToken,
  establishSession,
  sessionOptions,
  destroySession,
} from "../../src/platform/auth/session-security.js";
const token = "a".repeat(43);
function check(method: string, headers: Request["headers"], csrf = token) {
  let status = 200;
  let accepted = false;
  const responseHeaders: Record<string, string> = {};
  const request = { method, headers, session: { csrf } } as Request;
  const response = {
    setHeader(name: string, value: string) {
      responseHeaders[name] = value;
    },
    status(value: number) {
      status = value;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  cookieOriginGuard("https://escalator.example")(request, response, () => {
    accepted = true;
  });
  return { status, accepted, responseHeaders };
}
test("cookie mutations require exact origin and the current session CSRF token", () => {
  assert.equal(
    check("POST", {
      origin: "https://escalator.example",
      "x-escalator-csrf": token,
    }).accepted,
    true,
  );
  for (const headers of [
    {},
    { origin: "https://attacker.example", "x-escalator-csrf": token },
    { origin: "https://escalator.example" },
    { origin: "https://escalator.example", "x-escalator-csrf": "b".repeat(43) },
    { origin: "https://escalator.example", "x-escalator-csrf": "é".repeat(43) },
    { origin: "https://escalator.example", "x-escalator-csrf": [token, token] },
  ]) {
    assert.equal(check("POST", headers).status, 403);
    assert.equal(check("POST", headers).accepted, false);
  }
});
test("cross-site reads are rejected and auth responses are never cacheable", () => {
  assert.equal(
    check("GET", { "sec-fetch-site": "cross-site" }).accepted,
    false,
  );
  assert.equal(
    check("GET", { origin: "https://attacker.example" }).accepted,
    false,
  );
  assert.equal(check("GET", {}).accepted, true);
  assert.equal(check("GET", {}).responseHeaders["Cache-Control"], "no-store");
});
test("production cookies are host-only secure and no MemoryStore fallback is selected", () => {
  class UnusedStore extends session.Store {
    override get(): never {
      throw new Error("Unexpected store read");
    }
    override set(): never {
      throw new Error("Unexpected store write");
    }
    override destroy(): never {
      throw new Error("Unexpected store revoke");
    }
  }
  const store = new UnusedStore();
  const options = sessionOptions(
    new URL("https://escalator.example"),
    [token],
    store,
  );
  assert.equal(options.store, store);
  assert.equal(options.name, "__Host-escalator");
  assert.deepEqual(options.cookie, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 28800000,
  });
  assert.equal(options.saveUninitialized, false);
  assert.equal(options.resave, false);
  assert.throws(() =>
    sessionOptions(new URL("http://escalator.example"), [token], store),
  );
  assert.throws(() =>
    sessionOptions(new URL("https://escalator.example"), [], store),
  );
  const localCookie = sessionOptions(
    new URL("http://localhost:3000"),
    [token],
    store,
  ).cookie;
  assert.ok(localCookie && typeof localCookie !== "function");
  assert.equal(localCookie.secure, false);
});
test("successful login regenerates before storing identity and waits for persistence", async () => {
  const calls: string[] = [];
  const request = {
    session: {
      csrf: "old",
      regenerate(done: (error?: Error) => void) {
        calls.push("regenerate");
        request.session = {
          save(done: (error?: Error) => void) {
            calls.push("save");
            done();
          },
        } as typeof request.session;
        done();
      },
    },
  } as unknown as Request;
  await establishSession(request, { accountId: "owner", authVersion: 2 });
  assert.deepEqual(calls, ["regenerate", "save"]);
  assert.deepEqual(request.session.account, {
    accountId: "owner",
    authVersion: 2,
  });
  assert.match(request.session.csrf!, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(request.session.csrf, "old");
  assert.equal(csrfToken(request), request.session.csrf);
});
test("session persistence and logout errors propagate instead of claiming success", async () => {
  const request = {
    session: {
      regenerate(done: (error?: Error) => void) {
        done(new Error("store unavailable"));
      },
      destroy(done: (error?: Error) => void) {
        done(new Error("store unavailable"));
      },
    },
  } as unknown as Request;
  await assert.rejects(
    establishSession(request, { accountId: "owner", authVersion: 1 }),
  );
  await assert.rejects(destroySession(request));
});
