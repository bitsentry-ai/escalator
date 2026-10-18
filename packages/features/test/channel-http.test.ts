import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request, RequestOptions } from "node:https";
import { PublicHttpsChannelTransport } from "../src/adapters/channels/https-transport.js";
import { isPublicChannelAddress } from "../src/adapters/channels/public-address.js";

const input = () => ({
  url: "https://notify.example/path?secret=private",
  method: "POST" as const,
  headers: { authorization: "Bearer private" },
  body: "payload",
  signal: new AbortController().signal,
});
function socketFixture(status = 200, body = "ok", complete = true) {
  const calls: Array<{ url: URL; options: RequestOptions; body?: string }> = [];
  const fake = ((
    url: URL,
    options: RequestOptions,
    callback: (res: unknown) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      end(body?: string): void;
      destroy(error?: Error): void;
    };
    req.destroy = (error) => {
      if (error) req.emit("error", error);
    };
    req.end = (sent) => {
      calls.push({ url, options, body: sent });
      queueMicrotask(() => {
        const res = Object.assign(new PassThrough(), {
          statusCode: status,
          complete,
        });
        callback(res);
        res.end(body);
      });
    };
    return req;
  }) as unknown as typeof request;
  return { fake, calls };
}
test("outbound address policy rejects private, special and encoded transition ranges", () => {
  for (const address of [
    "0.1.2.3",
    "10.2.3.4",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.2.3",
    "192.168.1.1",
    "192.0.0.9",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "fe80::1",
    "fc00::1",
    "2001::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3fff::1",
    "2606:4700::1%eth0",
    "not-an-ip",
  ])
    assert.equal(isPublicChannelAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicChannelAddress(address), true, address);
});
test("transport pins validated DNS while preserving TLS hostname and refuses redirects", async () => {
  const f = socketFixture(302, "redirect");
  let resolutions = 0;
  const transport = new PublicHttpsChannelTransport(async () => {
    resolutions++;
    return [{ address: "8.8.8.8", family: 4 }];
  }, f.fake);
  assert.deepEqual(await transport.send(input()), {
    status: 302,
    body: "redirect",
  });
  assert.equal(resolutions, 1);
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0]!;
  assert.equal(url.hostname, "notify.example");
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(
    (options as RequestOptions & { autoSelectFamily: boolean })
      .autoSelectFamily,
    false,
  );
  assert.equal(options.maxHeaderSize, 16384);
  const lookup = options.lookup as (
    host: string,
    options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => void;
  lookup("notify.example", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
});
test("mixed DNS answers, literal private addresses and unsafe requests never reach a socket", async () => {
  const f = socketFixture();
  const transport = new PublicHttpsChannelTransport(
    async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    f.fake,
  );
  for (const value of [
    input(),
    { ...input(), url: "https://2130706433/" },
    { ...input(), url: "http://notify.example/" },
    { ...input(), url: "https://user:pass@notify.example/" },
    { ...input(), url: "https://notify.example:8443/" },
    { ...input(), headers: { host: "internal" } },
    { ...input(), headers: { authorization: "bad\r\nheader" } },
    { ...input(), body: "x".repeat(16385) },
  ])
    await assert.rejects(transport.send(value), {
      message: "Channel HTTP request failed",
    });
  assert.equal(f.calls.length, 0);
});
test("oversized or incomplete responses fail without leaking provider details", async () => {
  for (const f of [
    socketFixture(200, "s".repeat(65537)),
    socketFixture(200, "secret", false),
  ]) {
    const transport = new PublicHttpsChannelTransport(
      async () => [{ address: "8.8.8.8", family: 4 }],
      f.fake,
    );
    await assert.rejects(transport.send(input()), {
      message: "Channel HTTP request failed",
    });
  }
});
test("abort during DNS returns promptly and cannot subsequently open a socket", async () => {
  const f = socketFixture();
  let resolve!: (addresses: { address: string; family: number }[]) => void;
  const transport = new PublicHttpsChannelTransport(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    f.fake,
  );
  const controller = new AbortController();
  const sent = transport.send({ ...input(), signal: controller.signal });
  controller.abort();
  await assert.rejects(sent, { message: "Channel HTTP request failed" });
  resolve([{ address: "8.8.8.8", family: 4 }]);
  await new Promise((done) => setImmediate(done));
  assert.equal(f.calls.length, 0);
});
test("total deadline includes a stalled resolver", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = socketFixture();
  const transport = new PublicHttpsChannelTransport(
    () => new Promise(() => {}),
    f.fake,
  );
  const sent = transport.send(input());
  t.mock.timers.tick(10_000);
  await assert.rejects(sent, { message: "Channel HTTP request failed" });
  assert.equal(f.calls.length, 0);
});
