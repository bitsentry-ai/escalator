import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { TLSSocket, ConnectionOptions } from "node:tls";
import type { createTransport } from "nodemailer";
import { PublicSmtpTransport } from "../src/adapters/channels/smtp-transport.js";
const credentials = {
  host: "smtp.example.com",
  port: 465 as const,
  username: "user",
  password: "private",
  from: "ops@example.com",
  to: "oncall@example.com",
};
const message = {
  subject: "Outage",
  text: "API down\nhttps://ops.example/ack#token=private",
  messageId: `<${"a".repeat(64)}@escalator.invalid>`,
};
function fixture(
  options: {
    addresses?: { address: string; family: number }[];
    result?: unknown;
    error?: unknown;
    hold?: boolean;
    unauthorized?: boolean;
  } = {},
) {
  let dns = 0,
    mailers = 0,
    destroyed = 0,
    closed = 0;
  let socketOptions: ConnectionOptions | undefined;
  let mailOptions: Record<string, unknown> | undefined;
  let sent: Record<string, unknown> | undefined;
  let resolveSend: ((value: unknown) => void) | undefined;
  class FakeSocket extends EventEmitter {
    authorized = !options.unauthorized;
    destroy() {
      destroyed++;
      this.emit("close");
      return this;
    }
  }
  const socket = new FakeSocket();
  const create = ((input: Record<string, unknown>) => {
    mailers++;
    mailOptions = input;
    const getSocket = input.getSocket as (
      options: unknown,
      callback: (
        error: unknown,
        value: { connection: unknown; secured: boolean },
      ) => void,
    ) => void;
    getSocket(input, (error, value) => {
      assert.ifError(error);
      assert.equal(value.connection, socket);
      assert.equal(value.secured, true);
    });
    return {
      close() {
        closed++;
      },
      async sendMail(input: Record<string, unknown>) {
        sent = input;
        if (options.error) throw options.error;
        if (options.hold)
          return new Promise((resolve) => {
            resolveSend = resolve;
          });
        return options.result ?? { accepted: [credentials.to], rejected: [] };
      },
    };
  }) as unknown as typeof createTransport;
  const transport = new PublicSmtpTransport(
    async () => {
      dns++;
      return options.addresses ?? [{ address: "8.8.8.8", family: 4 }];
    },
    (input) => {
      socketOptions = input;
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket as unknown as TLSSocket;
    },
    create,
  );
  return {
    transport,
    socket,
    state: () => ({
      dns,
      mailers,
      destroyed,
      closed,
      socketOptions,
      mailOptions,
      sent,
    }),
    resolve: (value: unknown) => resolveSend?.(value),
  };
}
test("SMTP pins public DNS while preserving hostname verification and bounded provider options", async () => {
  const f = fixture();
  assert.equal(
    await f.transport.send(credentials, message, new AbortController().signal),
    "accepted",
  );
  const s = f.state();
  assert.equal(s.dns, 1);
  assert.equal(s.socketOptions!.host, "8.8.8.8");
  assert.equal(s.socketOptions!.servername, credentials.host);
  assert.equal(s.socketOptions!.rejectUnauthorized, true);
  assert.equal(s.socketOptions!.port, 465);
  assert.equal(s.socketOptions!.minVersion, "TLSv1.2");
  for (const key of ["logger", "debug", "transactionLog", "pool"])
    assert.equal(s.mailOptions![key], false);
  for (const key of [
    "secure",
    "forceAuth",
    "disableFileAccess",
    "disableUrlAccess",
  ])
    assert.equal(s.mailOptions![key], true);
  assert.equal(s.mailOptions!.maxResponseSize, 65536);
  assert.equal(s.mailOptions!.maxRecipients, 1);
  assert.deepEqual(s.sent!.envelope, {
    from: credentials.from,
    to: [credentials.to],
  });
  assert.equal(s.sent!.text, message.text);
  assert.equal(s.sent!.html, undefined);
  assert.equal(s.closed, 1);
  assert.equal(s.destroyed, 1);
});
for (const addresses of [
  [],
  [{ address: "127.0.0.1", family: 4 }],
  [
    { address: "8.8.8.8", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ],
  [{ address: "8.8.8.8", family: 6 }],
])
  test(
    "SMTP rejects every unsafe or inconsistent DNS set " +
      JSON.stringify(addresses),
    async () => {
      const f = fixture({ addresses });
      assert.equal(
        await f.transport.send(
          credentials,
          message,
          new AbortController().signal,
        ),
        "unknown",
      );
      assert.equal(f.state().socketOptions, undefined);
      assert.equal(f.state().mailers, 0);
    },
  );
test("SMTP refuses a TLS socket that did not authenticate its peer", async () => {
  const f = fixture({ unauthorized: true });
  assert.equal(
    await f.transport.send(credentials, message, new AbortController().signal),
    "unknown",
  );
  assert.equal(f.state().mailers, 0);
  assert.equal(f.state().destroyed, 1);
});
test("SMTP abort destroys the actual connection and cannot later accept a completed send", async () => {
  const f = fixture({ hold: true });
  const controller = new AbortController();
  const result = f.transport.send(credentials, message, controller.signal);
  for (let i = 0; i < 10 && !f.state().sent; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.state().sent);
  controller.abort();
  assert.equal(await result, "unknown");
  assert.ok(f.state().destroyed >= 1);
  f.resolve({ accepted: [credentials.to], rejected: [] });
  assert.equal(f.state().closed, 1);
});
test("SMTP already-aborted operation performs no DNS or socket work", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await f.transport.send(credentials, message, controller.signal),
    "unknown",
  );
  assert.equal(f.state().dns, 0);
  assert.equal(f.state().mailers, 0);
});
for (const [code, expected] of [
  [421, "retry"],
  [550, "rejected"],
  [250, "unknown"],
] as const)
  test("SMTP explicit reply classification " + code, async () => {
    const f = fixture({
      error: { responseCode: code, message: "private server text" },
    });
    assert.equal(
      await f.transport.send(
        credentials,
        message,
        new AbortController().signal,
      ),
      expected,
    );
  });
for (const result of [
  { accepted: [], rejected: [] },
  { accepted: ["someone@example.com"], rejected: [] },
  { accepted: [credentials.to], rejected: ["other@example.com"] },
])
  test(
    "SMTP does not claim acceptance for a mismatched receipt " +
      JSON.stringify(result),
    async () => {
      const f = fixture({ result });
      assert.equal(
        await f.transport.send(
          credentials,
          message,
          new AbortController().signal,
        ),
        "unknown",
      );
    },
  );
test("SMTP total deadline bounds stalled DNS and never connects after late resolution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: { address: string; family: number }[]) => void;
  let connections = 0;
  const transport = new PublicSmtpTransport(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {
      connections++;
      throw new Error("must not connect");
    },
  );
  const result = transport.send(
    credentials,
    message,
    new AbortController().signal,
  );
  t.mock.timers.tick(10000);
  assert.equal(await result, "unknown");
  finish([{ address: "8.8.8.8", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections, 0);
});
