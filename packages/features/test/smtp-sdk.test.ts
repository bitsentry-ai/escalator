import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { PublicSmtpTransport } from "../src/adapters/channels/smtp-transport.js";
/** In-memory protocol fixture only; no listening socket or network is created. */
class SubmissionFixture extends Duplex {
  authorized = true;
  readonly commands: string[] = [];
  body = "";
  private data = false;
  private buffered = "";
  setTimeout() {
    return this;
  }
  _read() {
    /* Responses are pushed as the scripted peer advances. */
  }
  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.buffered += chunk.toString();
    if (this.data) {
      if (this.buffered.endsWith("\r\n.\r\n")) {
        this.body = this.buffered;
        this.buffered = "";
        this.data = false;
        this.push("250 2.0.0 queued\r\n");
      }
    } else {
      let boundary: number;
      while ((boundary = this.buffered.indexOf("\r\n")) >= 0) {
        const command = this.buffered.slice(0, boundary);
        this.buffered = this.buffered.slice(boundary + 2);
        this.commands.push(command);
        if (command.startsWith("EHLO "))
          this.push("250-smtp.example.com\r\n250 AUTH PLAIN\r\n");
        else if (command.startsWith("AUTH PLAIN "))
          this.push("235 2.7.0 authenticated\r\n");
        else if (/^(MAIL FROM:|RCPT TO:)/.test(command))
          this.push("250 2.1.0 ok\r\n");
        else if (command === "DATA") {
          this.data = true;
          this.push("354 send message\r\n");
        } else if (command === "QUIT") this.push("221 bye\r\n");
        else return callback(new Error("Unexpected SMTP fixture command"));
      }
    }
    callback();
  }
}
test("real Nodemailer uses the supplied TLS socket for authentication and MIME submission", async () => {
  const peer = new SubmissionFixture();
  const transport = new PublicSmtpTransport(
    async () => [{ address: "8.8.8.8", family: 4 }],
    () => {
      queueMicrotask(() => {
        peer.emit("secureConnect");
        peer.push("220 smtp.example.com ESMTP\r\n");
      });
      return peer as unknown as TLSSocket;
    },
  );
  const result = await transport.send(
    {
      host: "smtp.example.com",
      port: 465,
      username: "fixture-user",
      password: "fixture-password",
      from: "Ops@EXAMPLE.COM",
      to: "oncall@EXAMPLE.COM",
    },
    {
      subject: "API outage",
      text: "API failed\nhttps://ops.example/ack#token=fixture-token",
      messageId: `<${"a".repeat(64)}@escalator.invalid>`,
    },
    new AbortController().signal,
  );
  assert.equal(result, "accepted");
  assert.ok(peer.commands.some((command) => command.startsWith("AUTH PLAIN ")));
  assert.ok(peer.commands.includes("RCPT TO:<oncall@example.com>"));
  assert.ok(peer.commands.includes("MAIL FROM:<Ops@example.com>"));
  assert.match(peer.body, /Content-Type: text\/plain/);
  assert.match(peer.body, /Subject: API outage/);
  assert.match(peer.body, /fixture-token/);
  assert.equal(peer.destroyed, true);
});
