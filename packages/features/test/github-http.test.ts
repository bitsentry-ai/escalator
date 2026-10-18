import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { request, RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import {
  GithubDiffHttp,
  GithubDiffError,
} from "../src/investigation/evidence/github-http.js";
import { repositoryComparisonSchema } from "../src/investigation/evidence/github-diff.js";
const binding = repositoryComparisonSchema.parse({
  scope: {
    workspaceId: "org_a",
    serviceId: "api",
    environmentId: "prod",
    incidentId: "incident",
  },
  sourceId: "repository",
  owner: "bitsentry-ai",
  repository: "api",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  observedAt: "2026-10-01T01:00:00.000Z",
  deploymentReceivedAt: "2026-10-01T01:00:01.000Z",
});
const context = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
});
const publicPeer = [{ address: "8.8.8.8", family: 4 }];
const reason = (expected: string) => (error: unknown) =>
  error instanceof GithubDiffError &&
  error.reason === expected &&
  !/test-secret|private-query/.test(error.message);
type Reply = {
  status?: number;
  body?: Buffer;
  headers?: Record<string, string>;
  incomplete?: boolean;
  hang?: boolean;
  error?: boolean;
};
function network(reply: Reply = {}) {
  const calls: {
    url: URL;
    options: RequestOptions;
    body: unknown;
    destroyed: boolean;
  }[] = [];
  const send = ((
    url: URL,
    options: RequestOptions,
    consume: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (body?: unknown) => void;
      destroy: () => void;
    };
    const call = { url, options, body: undefined as unknown, destroyed: false };
    calls.push(call);
    req.destroy = () => {
      call.destroyed = true;
    };
    req.end = (body) => {
      call.body = body;
      queueMicrotask(() => {
        if (reply.error) {
          req.emit("error", new Error("test-secret private-query"));
          return;
        }
        if (reply.hang) return;
        const response = Readable.from([
          reply.body ?? Buffer.from('{"ok":true}'),
        ]) as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        response.complete = !reply.incomplete;
        consume(response);
      });
    };
    return req;
  }) as unknown as typeof request;
  return { calls, send };
}
test("one GET pins a public peer and verifies TLS without proxy, body or redirects", async () => {
  const net = network();
  let resolutions = 0;
  const reader = new GithubDiffHttp(async (host) => {
    assert.equal(host, "api.github.com");
    resolutions++;
    return publicPeer;
  }, net.send);
  assert.equal(
    await reader.read(binding, "test-secret", context()),
    '{"ok":true}',
  );
  assert.equal(resolutions, 1);
  assert.equal(net.calls.length, 1);
  const call = net.calls[0]!;
  assert.equal(call.url.origin, "https://api.github.com");
  assert.equal(
    call.url.pathname,
    `/repos/bitsentry-ai/api/compare/${binding.baseSha}...${binding.headSha}`,
  );
  assert.equal(call.url.search, "");
  assert.equal(call.options.method, "GET");
  assert.equal(call.body, undefined);
  assert.equal(call.options.agent, false);
  assert.equal(call.options.rejectUnauthorized, true);
  assert.equal(call.options.maxHeaderSize, 16384);
  assert.equal(
    (call.options as RequestOptions & { autoSelectFamily: boolean })
      .autoSelectFamily,
    false,
  );
  assert.equal(
    (call.options.headers as Record<string, string>).authorization,
    "Bearer test-secret",
  );
  assert.equal(
    (call.options.headers as Record<string, string>)["accept-encoding"],
    "identity",
  );
  const lookup = call.options.lookup as unknown as (
    host: string,
    options: unknown,
    callback: (error: unknown, address: string, family: number) => void,
  ) => void;
  lookup("unrelated.invalid", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
});
test("public repositories can be read without attaching a credential", async () => {
  const net = network();
  await new GithubDiffHttp(async () => publicPeer, net.send).read(
    binding,
    undefined,
    context(),
  );
  assert.equal(
    "authorization" in (net.calls[0]!.options.headers as object),
    false,
  );
});
for (const peers of [
  [],
  [{ address: "127.0.0.1", family: 4 }],
  [...publicPeer, { address: "10.0.0.1", family: 4 }],
  [{ address: "8.8.8.8", family: 6 }],
  Array.from({ length: 65 }, () => publicPeer[0]!),
])
  test(`rejects unsafe DNS answer ${JSON.stringify(peers.slice(0, 2))} count ${peers.length}`, async () => {
    const net = network();
    await assert.rejects(
      new GithubDiffHttp(async () => peers, net.send).read(
        binding,
        "test-secret",
        context(),
      ),
      reason("unreachable"),
    );
    assert.equal(net.calls.length, 0);
  });
for (const [status, failure] of [
  [301, "invalid_response"],
  [302, "invalid_response"],
  [307, "invalid_response"],
  [401, "not_authorized"],
  [403, "not_authorized"],
  [404, "not_found"],
  [429, "invalid_response"],
  [500, "invalid_response"],
] as const)
  test(`status ${status} does not follow response URLs or retry`, async () => {
    const net = network({
      status,
      headers: { location: "http://127.0.0.1/private-query" },
    });
    await assert.rejects(
      new GithubDiffHttp(async () => publicPeer, net.send).read(
        binding,
        "test-secret",
        context(),
      ),
      reason(failure),
    );
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0]!.destroyed, true);
  });
test("bounds declared and streamed response bytes and rejects compressed bodies", async () => {
  const replies: Reply[] = [
    { headers: { "content-length": "1048577" } },
    { headers: { "content-length": "oops" } },
    { headers: { "content-encoding": "gzip" } },
    { body: Buffer.alloc(1048577) },
  ];
  for (const reply of replies) {
    const net = network(reply);
    await assert.rejects(
      new GithubDiffHttp(async () => publicPeer, net.send).read(
        binding,
        undefined,
        context(),
      ),
      reason("invalid_response"),
    );
    assert.equal(net.calls[0]!.destroyed, true);
  }
});
test("invalid UTF-8 and incomplete HTTP bodies cannot become evidence", async () => {
  for (const reply of [{ body: Buffer.from([0xff]) }, { incomplete: true }]) {
    const net = network(reply);
    await assert.rejects(
      new GithubDiffHttp(async () => publicPeer, net.send).read(
        binding,
        undefined,
        context(),
      ),
      reason("invalid_response"),
    );
  }
});
test("raw network errors never reveal credentials or provider paths", async () => {
  const net = network({ error: true });
  await assert.rejects(
    new GithubDiffHttp(async () => publicPeer, net.send).read(
      binding,
      "test-secret",
      context(),
    ),
    reason("unreachable"),
  );
});
test("already cancelled calls do not resolve DNS or make a request", async () => {
  const net = network();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    new GithubDiffHttp(async () => {
      calls++;
      return publicPeer;
    }, net.send).read(binding, undefined, {
      ...context(),
      signal: controller.signal,
    }),
    reason("cancelled"),
  );
  assert.equal(calls, 0);
  assert.equal(net.calls.length, 0);
});
test("timeout fences a stalled DNS lookup and a stalled response", async () => {
  const net = network();
  await assert.rejects(
    new GithubDiffHttp(() => new Promise(() => {}), net.send).read(
      binding,
      undefined,
      { ...context(), timeoutMs: 5 },
    ),
    reason("timeout"),
  );
  assert.equal(net.calls.length, 0);
  const hanging = network({ hang: true });
  await assert.rejects(
    new GithubDiffHttp(async () => publicPeer, hanging.send).read(
      binding,
      undefined,
      { ...context(), timeoutMs: 5 },
    ),
    reason("timeout"),
  );
  assert.equal(hanging.calls[0]!.options.signal?.aborted, true);
});
test("cancelling a stalled response aborts its request signal", async () => {
  const net = network({ hang: true });
  const controller = new AbortController();
  const pending = new GithubDiffHttp(async () => publicPeer, net.send).read(
    binding,
    undefined,
    { ...context(), signal: controller.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, reason("cancelled"));
  assert.equal(net.calls[0]!.options.signal?.aborted, true);
});
test("rejects symbolic refs, path injection, invalid token and invalid deadline before I/O", async () => {
  const net = network();
  const reader = new GithubDiffHttp(async () => publicPeer, net.send);
  for (const token of [
    "",
    "test-secret\r\nx-header: bad",
    "has space",
    "x".repeat(8193),
  ])
    await assert.rejects(
      reader.read(binding, token, context()),
      reason("invalid_configuration"),
    );
  for (const timeoutMs of [0, 10001, 1.5, NaN])
    await assert.rejects(
      reader.read(binding, undefined, { ...context(), timeoutMs }),
      reason("invalid_configuration"),
    );
  await assert.rejects(
    reader.read(
      { ...binding, owner: "../private-query" },
      undefined,
      context(),
    ),
    reason("invalid_configuration"),
  );
  await assert.rejects(
    reader.read({ ...binding, headSha: "main" }, undefined, context()),
    reason("invalid_configuration"),
  );
  assert.equal(net.calls.length, 0);
});

test("mutating caller configuration during DNS cannot change the approved endpoint", async () => {
  let release: (value: typeof publicPeer) => void = () => {};
  const resolved = new Promise<typeof publicPeer>((resolve) => {
    release = resolve;
  });
  const net = network();
  const comparison = structuredClone(binding);
  const pending = new GithubDiffHttp(() => resolved, net.send).read(
    comparison,
    undefined,
    context(),
  );
  comparison.owner = "another-owner";
  comparison.headSha = "c".repeat(40);
  release(publicPeer);
  await pending;
  assert.equal(
    net.calls[0]!.url.pathname,
    `/repos/bitsentry-ai/api/compare/${binding.baseSha}...${binding.headSha}`,
  );
});
