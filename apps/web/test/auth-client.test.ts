import test from "node:test";
import assert from "node:assert/strict";
import { LocalAuthClient } from "../src/auth/auth-client.js";
const csrf = "a".repeat(43);
const rotated = "b".repeat(43);
function response(data: unknown) {
  return new Response(JSON.stringify({ result: { data } }), { status: 200 });
}
test("auth transport acquires CSRF first and never puts credentials in URLs", async () => {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url).endsWith("session")
      ? response({ csrf, user: null })
      : response({ csrf: rotated });
  };
  const client = new LocalAuthClient(fetcher);
  await client.login({
    login: "owner",
    password: "private-password",
    factor: "123456",
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/trpc/auth.session", "/trpc/auth.login"],
  );
  assert.equal(calls[1].options?.credentials, "same-origin");
  assert.equal(
    new Headers(calls[1].options?.headers).get("x-escalator-csrf"),
    csrf,
  );
  assert.equal(
    JSON.parse(String(calls[1].options?.body)).password,
    "private-password",
  );
  await client.invite("viewer");
  assert.equal(
    new Headers(calls[2].options?.headers).get("x-escalator-csrf"),
    rotated,
  );
});
test("failed mutations are not replayed automatically and the next attempt gets a fresh session", async () => {
  let sessions = 0;
  let mutations = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("session")) {
      sessions++;
      return response({ csrf, user: null });
    }
    mutations++;
    return new Response("Forbidden", { status: 403 });
  };
  const client = new LocalAuthClient(fetcher);
  await assert.rejects(client.login({ login: "owner", password: "password" }));
  assert.equal(mutations, 1);
  assert.equal(sessions, 1);
  await assert.rejects(client.login({ login: "owner", password: "password" }));
  assert.equal(mutations, 2);
  assert.equal(sessions, 2);
});
test("logout discards the old CSRF token and internal error bodies stay private", async () => {
  let sessions = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("session")) {
      sessions++;
      return response({ csrf, user: null });
    }
    if (String(url).endsWith("logout")) return response({ ok: true });
    return new Response("sensitive-server-error", { status: 500 });
  };
  const client = new LocalAuthClient(fetcher);
  await client.session();
  await client.logout();
  await assert.rejects(
    client.login({ login: "owner", password: "password" }),
    (error) => error instanceof Error && !error.message.includes("sensitive"),
  );
  assert.equal(sessions, 2);
});
