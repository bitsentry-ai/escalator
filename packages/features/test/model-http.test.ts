import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { request, RequestOptions, IncomingMessage } from "node:http";
import { ModelDestinationPolicy } from "../src/investigation/models/destination-policy.js";
import {
  BoundedModelHttp,
  ModelTransportError,
} from "../src/investigation/models/http.js";
const publicPeer = [{ address: "8.8.8.8", family: 4 }];
const rules = {
  hosts: [
    { hostname: "models.test", ports: [443, 80] },
    { hostname: "localhost", ports: [11434] },
    { hostname: "127.0.0.1", ports: [11434] },
    { hostname: "::1", ports: [11434] },
  ],
  privateCidrs: ["10.0.0.0/8"],
  allowLocalLoopback: true,
};
const context = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
});
const limits = { requestBytes: 1024, responseBytes: 1024 };
const requestBody = {
  method: "POST",
  body: '{"prompt":"untrusted"}',
  headers: { "content-type": "application/json", authorization: "Bearer test" },
};
const reason = (expected: string) => (error: unknown) =>
  error instanceof ModelTransportError && error.reason === expected;
type Reply = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  truncated?: boolean;
  hang?: boolean;
};
function network(replies: Reply[]) {
  const calls: { url: URL; options: RequestOptions; body: string }[] = [];
  const send = ((
    url: URL,
    options: RequestOptions,
    consume: (response: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
    };
    const call = { url, options, body: "" };
    calls.push(call);
    req.end = (body) => {
      call.body = body;
      queueMicrotask(() => {
        const reply = replies.shift();
        if (!reply) {
          req.emit("error", new Error("unexpected network request"));
          return;
        }
        if (reply.hang) return;
        const response = Readable.from([
          Buffer.from(reply.body ?? '{"ok":true}'),
        ]) as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {
          "content-type": "application/json",
        };
        consume(response);
        if (reply.truncated)
          response.destroy(new Error("secret source URL must not leak"));
      });
    };
    return req;
  }) as unknown as typeof request;
  return { calls, http: send, https: send };
}

test("model requests pin validated DNS, keep TLS verification and suppress proxy/reuse", async () => {
  const net = network([{}]);
  let resolutions = 0;
  const transport = new BoundedModelHttp(
    new ModelDestinationPolicy(rules),
    async () => {
      resolutions++;
      return publicPeer;
    },
    net,
  );
  const fetch = transport.bind(
    "https://models.test/v1",
    "remote",
    context(),
    limits,
  );
  const response = await fetch("https://models.test/v1/responses", requestBody);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(resolutions, 1);
  assert.equal(net.calls.length, 1);
  const { options } = net.calls[0];
  assert.equal(options.agent, false);
  assert.equal(
    (options as { rejectUnauthorized?: boolean }).rejectUnauthorized,
    true,
  );
  assert.equal(
    (options as { autoSelectFamily?: boolean }).autoSelectFamily,
    false,
  );
  assert.equal(
    (options.headers as Record<string, string>)["accept-encoding"],
    "identity",
  );
  const lookup = options.lookup as unknown as (
    host: string,
    options: object,
    callback: (error: Error | null, address: string, family: number) => void,
  ) => void;
  lookup("models.test", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
});

test("only explicitly approved local loopback can reach local Ollama", async () => {
  for (const endpoint of ["http://127.0.0.1:11434", "http://[::1]:11434"]) {
    const net = network([{}]);
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      async () => {
        throw new Error("IP literal must not use DNS");
      },
      net,
    );
    await transport.bind(
      endpoint,
      "local",
      context(),
      limits,
    )(endpoint + "/api/generate", requestBody);
    assert.equal(net.calls.length, 1);
  }
  const denied = new BoundedModelHttp(
    new ModelDestinationPolicy({ ...rules, allowLocalLoopback: false }),
    async () => [],
    network([]),
  );
  await assert.rejects(
    denied.bind(
      "http://127.0.0.1:11434",
      "local",
      context(),
      limits,
    )("http://127.0.0.1:11434/api/generate", requestBody),
    reason("destination_denied"),
  );
});

test("local and remote destinations reject mixed DNS answers without connection or fallback", async () => {
  for (const [location, peers] of [
    ["local", publicPeer],
    ["local", [...publicPeer, { address: "127.0.0.1", family: 4 }]],
    ["remote", [{ address: "10.1.2.3", family: 4 }]],
    ["remote", [...publicPeer, { address: "127.0.0.1", family: 4 }]],
    ["remote", [{ address: "8.8.8.8", family: 6 }]],
  ] as const) {
    const net = network([]);
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      async () => [...peers],
      net,
    );
    await assert.rejects(
      transport.bind(
        "https://models.test",
        location,
        context(),
        limits,
      )("https://models.test/api/generate", requestBody),
      reason("destination_denied"),
    );
    assert.equal(net.calls.length, 0);
  }
});

test("model policy never permits metadata, mapped IPv6 or special-use peers", () => {
  const policy = new ModelDestinationPolicy({
    ...rules,
    privateCidrs: ["0.0.0.0/0", "::/0"],
  });
  for (const ip of [
    "169.254.169.254",
    "168.63.129.16",
    "100.100.100.200",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:10.1.2.3",
    "64:ff9b::a9fe:a9fe",
    "0.0.0.0",
    "224.0.0.1",
    "fe80::1",
    "fe80::1%lo",
    "bad",
  ]) {
    for (const location of ["local", "remote"] as const)
      assert.equal(policy.address(ip, location), false, ip);
  }
  assert.equal(policy.address("10.1.2.3", "local"), true);
  assert.equal(policy.address("0:0:0:0:0:0:0:1", "local"), true);
  assert.equal(policy.address("10.1.2.3", "remote"), false);
  assert.equal(
    new ModelDestinationPolicy({ ...rules, privateCidrs: [] }).address(
      "10.1.2.3",
      "local",
    ),
    false,
  );
});

test("endpoint binding rejects origin/path escapes, credentials, query and redirects", async () => {
  const net = network([
    { status: 307, headers: { location: "https://models.test/v1/other" } },
  ]);
  const transport = new BoundedModelHttp(
    new ModelDestinationPolicy(rules),
    async () => publicPeer,
    net,
  );
  const fetch = transport.bind(
    "https://models.test/v1",
    "remote",
    context(),
    limits,
  );
  for (const url of [
    "https://evil.test/v1/responses",
    "https://models.test/v10/responses",
    "https://models.test/v1/../admin",
    "https://user:key@models.test/v1/responses",
    "https://models.test/v1/responses?key=secret",
    "https://models.test/v1/%252e%252e/admin",
    "https://models.test/v1/foo%2fadmin",
    "https://models.test:8443/v1/responses",
  ])
    await assert.rejects(fetch(url, requestBody), reason("destination_denied"));
  assert.equal(net.calls.length, 0);
  await assert.rejects(
    fetch("https://models.test/v1/responses", requestBody),
    reason("destination_denied"),
  );
  assert.equal(net.calls.length, 1);
  assert.throws(() =>
    transport.bind("http://models.test", "remote", context(), limits),
  );
});

test("transport bounds request bytes and rejects method, streamed bodies and unsafe headers", async () => {
  const net = network([]);
  const transport = new BoundedModelHttp(
    new ModelDestinationPolicy(rules),
    async () => publicPeer,
    net,
  );
  const fetch = transport.bind(
    "https://models.test",
    "remote",
    context(),
    limits,
  );
  for (const init of [
    { ...requestBody, body: "界".repeat(400) },
    { ...requestBody, method: "GET" },
    { ...requestBody, body: new Uint8Array(4) },
    { ...requestBody, headers: { ...requestBody.headers, host: "evil.test" } },
    { ...requestBody, headers: { "content-type": "text/plain" } },
    {
      ...requestBody,
      headers: { ...requestBody.headers, authorization: "a".repeat(8193) },
    },
  ])
    await assert.rejects(
      fetch("https://models.test/api/generate", init),
      reason("invalid_configuration"),
    );
  assert.equal(net.calls.length, 0);
});

for (const reply of [
  { body: "x".repeat(1025) },
  { headers: { "content-length": "1025" } },
])
  test("response bodies are bounded before SDK JSON parsing", async () => {
    const net = network([reply]);
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      async () => publicPeer,
      net,
    );
    await assert.rejects(
      transport.bind(
        "https://models.test",
        "remote",
        context(),
        limits,
      )("https://models.test/v1/responses", requestBody),
      reason("response_limit"),
    );
  });

for (const reply of [
  { headers: { "content-encoding": "gzip" } },
  { truncated: true },
])
  test("compressed or truncated responses fail without raw details", async () => {
    const net = network([reply]);
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      async () => publicPeer,
      net,
    );
    await assert.rejects(
      transport.bind(
        "https://models.test",
        "remote",
        context(),
        limits,
      )("https://models.test/v1/responses", requestBody),
      reason("network_error"),
    );
  });

test("DNS and socket waits honor bounded timeouts even when an adapter ignores cancellation", async () => {
  for (const dnsHang of [true, false]) {
    const net = network([{ hang: true }]);
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      () => (dnsHang ? new Promise(() => {}) : Promise.resolve(publicPeer)),
      net,
    );
    await assert.rejects(
      transport.bind(
        "https://models.test",
        "remote",
        { ...context(), timeoutMs: 5 },
        limits,
      )("https://models.test/v1/responses", requestBody),
      reason("timeout"),
    );
    assert.equal(net.calls.length, dnsHang ? 0 : 1);
  }
});

test("parent and SDK cancellation prevent any new connection", async () => {
  for (const sdk of [true, false]) {
    const net = network([]);
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const transport = new BoundedModelHttp(
      new ModelDestinationPolicy(rules),
      async () => publicPeer,
      net,
    );
    const fetch = transport.bind(
      "https://models.test",
      "remote",
      sdk ? context() : { ...context(), signal: controller.signal },
      limits,
    );
    await assert.rejects(
      fetch(
        "https://models.test/v1/responses",
        sdk ? { ...requestBody, signal: controller.signal } : requestBody,
      ),
      reason("cancelled"),
    );
    assert.equal(net.calls.length, 0);
  }
});

test("invalid transport budgets and unapproved endpoints fail before any I/O", () => {
  const net = network([]);
  const transport = new BoundedModelHttp(
    new ModelDestinationPolicy(rules),
    async () => publicPeer,
    net,
  );
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 120001])
    assert.throws(
      () =>
        transport.bind(
          "https://models.test",
          "remote",
          { ...context(), timeoutMs },
          limits,
        ),
      reason("invalid_configuration"),
    );
  for (const size of [0, -1, Number.NaN, 1048577]) {
    assert.throws(
      () =>
        transport.bind("https://models.test", "remote", context(), {
          ...limits,
          requestBytes: size,
        }),
      reason("invalid_configuration"),
    );
    assert.throws(
      () =>
        transport.bind("https://models.test", "remote", context(), {
          ...limits,
          responseBytes: size,
        }),
      reason("invalid_configuration"),
    );
  }
  for (const endpoint of [
    "https://unknown.test",
    "https://models.test?key=secret",
    "https://models.test/#secret",
    "file:///tmp/model",
    "https://user:secret@models.test",
  ])
    assert.throws(() => transport.bind(endpoint, "remote", context(), limits));
  assert.equal(net.calls.length, 0);
});

test("cancellation interrupts a pending DNS read before any connection", async () => {
  const net = network([]);
  const controller = new AbortController();
  const transport = new BoundedModelHttp(
    new ModelDestinationPolicy(rules),
    () => new Promise(() => {}),
    net,
  );
  const promise = transport.bind(
    "https://models.test",
    "remote",
    { ...context(), signal: controller.signal },
    limits,
  )("https://models.test/v1/responses", requestBody);
  controller.abort();
  await assert.rejects(promise, reason("cancelled"));
  assert.equal(net.calls.length, 0);
});
