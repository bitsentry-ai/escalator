import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { request, RequestOptions, IncomingMessage } from "node:http";
import { PolicyHttpProbeTransport } from "../src/adapters/probes/http.js";
import { ProbeDestinationPolicy } from "../src/adapters/probes/policy.js";
import {
  ProbeTransportError,
  type ProbeRequest,
} from "../src/application/probes/transport.js";
const input: ProbeRequest = {
  url: "https://example.test/health",
  method: "GET",
  headers: {},
  body: null,
  timeoutMs: 1000,
  maxResponseBytes: 100,
};
const publicPeer = [{ address: "8.8.8.8", family: 4 }];
const policy = (hosts = ["example.test"]) =>
  new ProbeDestinationPolicy({
    hosts: hosts.map((hostname) => ({ hostname, ports: [443, 80] })),
    privateCidrs: [],
  });
type Reply = {
  status?: number;
  body?: string;
  location?: string;
  truncated?: boolean;
};
function network(replies: Reply[]) {
  const calls: { url: URL; options: RequestOptions; body: string | null }[] =
    [];
  const send = ((
    url: URL,
    options: RequestOptions,
    consume: (response: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (body: string) => void;
      end: () => void;
    };
    const call = { url, options, body: null as string | null };
    calls.push(call);
    req.write = (body) => {
      call.body = body;
    };
    req.end = () =>
      queueMicrotask(() => {
        const reply = replies.shift();
        if (!reply) {
          req.emit("error", new Error("unexpected network request"));
          return;
        }
        const response = Readable.from([
          Buffer.from(reply.body ?? "ok"),
        ]) as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.location ? { location: reply.location } : {};
        consume(response);
        if (reply.truncated) response.destroy(new Error("truncated"));
      });
    return req;
  }) as unknown as typeof request;
  return { calls, http: send, https: send };
}
const reason = (expected: string) => (error: unknown) =>
  error instanceof ProbeTransportError && error.reason === expected;
test("HTTP probes pin the validated DNS peer and retain TLS verification", async () => {
  const net = network([{}]);
  let resolutions = 0;
  const transport = new PolicyHttpProbeTransport(
    policy(),
    async () => {
      resolutions++;
      return publicPeer;
    },
    net,
  );
  assert.deepEqual(
    await transport.exchange(input, new AbortController().signal),
    { status: 200, body: "ok" },
  );
  assert.equal(resolutions, 1);
  const options = net.calls[0].options;
  assert.equal(options.agent, false);
  assert.equal(options.family, 4);
  assert.equal(
    (options as { rejectUnauthorized?: boolean }).rejectUnauthorized,
    true,
  );
  assert.equal(
    (options as { autoSelectFamily?: boolean }).autoSelectFamily,
    false,
  );
  assert.deepEqual(options.headers, { "accept-encoding": "identity" });
  const lookup = options.lookup as unknown as (
    host: string,
    options: object,
    callback: (error: Error | null, address: string, family: number) => void,
  ) => void;
  lookup("example.test", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
});
test("a mixed public/private DNS answer fails before opening a connection", async () => {
  const net = network([]);
  const transport = new PolicyHttpProbeTransport(
    policy(),
    async () => [...publicPeer, { address: "127.0.0.1", family: 4 }],
    net,
  );
  await assert.rejects(
    transport.exchange(input, new AbortController().signal),
    reason("destination_denied"),
  );
  assert.equal(net.calls.length, 0);
});
test("redirects must pass a fresh host and DNS check", async () => {
  const denied = network([
    { status: 302, location: "http://169.254.169.254/latest" },
  ]);
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () => publicPeer,
      denied,
    ).exchange(input, new AbortController().signal),
    reason("destination_denied"),
  );
  assert.equal(denied.calls.length, 1);
  const rebound = network([{ status: 302, location: "/other" }]);
  let resolutions = 0;
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () =>
        ++resolutions === 1
          ? publicPeer
          : [{ address: "127.0.0.1", family: 4 }],
      rebound,
    ).exchange(input, new AbortController().signal),
    reason("destination_denied"),
  );
  assert.equal(resolutions, 2);
  assert.equal(rebound.calls.length, 1);
});
test("authenticated probes cannot redirect credentials to another origin or HTTP", async () => {
  for (const location of ["https://other.test/", "http://example.test/"]) {
    const net = network([{ status: 302, location }]);
    await assert.rejects(
      new PolicyHttpProbeTransport(
        policy(["example.test", "other.test"]),
        async () => publicPeer,
        net,
      ).exchange(
        { ...input, headers: { authorization: "Bearer secret" } },
        new AbortController().signal,
      ),
      reason("destination_denied"),
    );
    assert.equal(net.calls.length, 1);
  }
});
test("POST probes never follow redirects and GET redirect chains stop at the limit", async () => {
  const net = network([{ status: 307, location: "/other" }]);
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () => publicPeer,
      net,
    ).exchange(
      { ...input, method: "POST", body: '{"test":true}' },
      new AbortController().signal,
    ),
    reason("destination_denied"),
  );
  assert.equal(net.calls.length, 1);
  const chain = network(
    Array.from({ length: 4 }, () => ({ status: 302, location: "/again" })),
  );
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () => publicPeer,
      chain,
    ).exchange(input, new AbortController().signal),
    reason("destination_denied"),
  );
  assert.equal(chain.calls.length, 4);
});
test("response byte limits and truncated streams reject incomplete results", async () => {
  const large = network([{ body: "x".repeat(101) }]);
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () => publicPeer,
      large,
    ).exchange(input, new AbortController().signal),
    reason("response_limit"),
  );
  const truncated = network([{ truncated: true }]);
  await assert.rejects(
    new PolicyHttpProbeTransport(
      policy(),
      async () => publicPeer,
      truncated,
    ).exchange(input, new AbortController().signal),
    reason("network_error"),
  );
});
test("DNS waits are bounded by timeout and caller cancellation", async () => {
  const net = network([]);
  const transport = new PolicyHttpProbeTransport(
    policy(),
    () => new Promise(() => {}),
    net,
  );
  await assert.rejects(
    transport.exchange(
      { ...input, timeoutMs: 100 },
      new AbortController().signal,
    ),
    reason("timeout"),
  );
  const controller = new AbortController();
  const pending = transport.exchange(input, controller.signal);
  controller.abort();
  await assert.rejects(pending, reason("cancelled"));
  assert.equal(net.calls.length, 0);
});
test("private peers require deployment approval in addition to a host allowlist", async () => {
  const net = network([{}]);
  const approved = new ProbeDestinationPolicy({
    hosts: [{ hostname: "example.test", ports: [443] }],
    privateCidrs: ["10.0.0.0/8"],
  });
  const result = await new PolicyHttpProbeTransport(
    approved,
    async () => [{ address: "10.1.2.3", family: 4 }],
    net,
  ).exchange(input, new AbortController().signal);
  assert.equal(result.status, 200);
});
test("invalid headers, credentialed HTTP and excessive request bodies fail before I/O", async () => {
  const net = network([]);
  const transport = new PolicyHttpProbeTransport(
    policy(),
    async () => publicPeer,
    net,
  );
  const invalidHeaders: Record<string, string>[] = [
    { host: "other.test" },
    { authorization: "x\r\ninjected: y" },
    { Authorization: "a", authorization: "b" },
  ];
  for (const headers of invalidHeaders) {
    await assert.rejects(
      transport.exchange({ ...input, headers }, new AbortController().signal),
      reason("invalid_configuration"),
    );
  }
  await assert.rejects(
    transport.exchange(
      {
        ...input,
        url: "http://example.test/",
        headers: { "x-api-key": "secret" },
      },
      new AbortController().signal,
    ),
    reason("destination_denied"),
  );
  await assert.rejects(
    transport.exchange(
      { ...input, method: "POST", body: "x".repeat(65537) },
      new AbortController().signal,
    ),
    reason("invalid_configuration"),
  );
  assert.equal(net.calls.length, 0);
});

test("a stalled HTTP request receives the deadline and cancellation signal", async () => {
  let requests = 0;
  const send = ((_url: URL, options: RequestOptions) => {
    requests++;
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      options.signal!.addEventListener(
        "abort",
        () => req.emit("error", new Error("aborted")),
        { once: true },
      );
    };
    return req;
  }) as unknown as typeof request;
  const transport = new PolicyHttpProbeTransport(
    policy(),
    async () => publicPeer,
    { http: send, https: send },
  );
  await assert.rejects(
    transport.exchange(
      { ...input, timeoutMs: 100 },
      new AbortController().signal,
    ),
    reason("timeout"),
  );
  const controller = new AbortController();
  const pending = transport.exchange(input, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, reason("cancelled"));
  assert.equal(requests, 2);
});
