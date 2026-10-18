import test from "node:test";
import assert from "node:assert/strict";
import {
  AcknowledgementHttp,
  acknowledgementHeaders,
  acknowledgementHtml,
} from "../dist/esm/application/index.js";
import {
  captureAcknowledgement,
  acknowledgementHttpClient,
} from "../dist/esm/ui/index.js";
const token = "A".repeat(43);
test("capability GET previews only, POST acknowledges, and invalid scope/auth never reaches storage", async () => {
  const calls = [];
  const pages = {
    preview: async (...args) => {
      calls.push(["GET", ...args]);
      return { state: "open", pageId: "page", title: "API" };
    },
    acknowledge: async (...args) => {
      calls.push(["POST", ...args]);
      return { state: "acknowledged", pageId: "page", ownerId: "owner" };
    },
  };
  const http = new AcknowledgementHttp(pages, (id) => id === "org_one");
  assert.equal(
    (await http.execute("GET", "org_one", `Bearer ${token}`)).state,
    "open",
  );
  assert.deepEqual(calls, [["GET", "org_one", token]]);
  assert.equal(
    (await http.execute("POST", "org_one", `Bearer ${token}`)).state,
    "acknowledged",
  );
  for (const auth of [
    undefined,
    token,
    `Bearer ${token} `,
    `Bearer ${token},other`,
  ])
    assert.deepEqual(await http.execute("POST", "org_one", auth), {
      state: "invalid",
    });
  assert.deepEqual(await http.execute("POST", "org_other", `Bearer ${token}`), {
    state: "invalid",
  });
  assert.equal(calls.length, 2);
  assert.equal(acknowledgementHeaders["Cache-Control"], "no-store");
  assert.equal(acknowledgementHeaders["Referrer-Policy"], "no-referrer");
  assert.match(acknowledgementHtml, /width=device-width/);
});
test("browser capability capture removes fragments even for malformed links and supports API prefixes", () => {
  const cleared = [];
  const history = { replaceState: (...args) => cleared.push(args) };
  assert.deepEqual(
    captureAcknowledgement(
      { pathname: "/api/ack/org_one", search: "", hash: `#token=${token}` },
      history,
    ),
    { workspaceId: "org_one", token },
  );
  assert.deepEqual(cleared, [[null, "", "/api/ack/org_one"]]);
  assert.equal(
    captureAcknowledgement(
      {
        pathname: "/ack/org_one",
        search: "",
        hash: `#token=${token}&token=${token}`,
      },
      history,
    ),
    undefined,
  );
  assert.equal(cleared.length, 2);
});
test("transport sends no capability in URLs, cookies or bodies and uses POST only on acknowledgement", async () => {
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({ state: "invalid" }) };
  };
  const client = acknowledgementHttpClient(
    "/api/ack/org_one/state",
    token,
    request,
  );
  const signal = new globalThis.AbortController().signal;
  await client.preview(signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].method, "GET");
  await client.acknowledge(signal);
  assert.equal(calls[1][1].method, "POST");
  for (const [url, options] of calls) {
    assert.equal(url, "/api/ack/org_one/state");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.body, undefined);
  }
});
