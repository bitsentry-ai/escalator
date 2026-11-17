import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect, type TLSSocket, type ConnectionOptions } from "node:tls";
import { createTransport } from "nodemailer";
import { emailCredentialsSchema } from "../../contracts/email-credentials.js";
import type { EmailTransport } from "./email.js";
import { isPublicChannelAddress } from "./public-address.js";
type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const failure = () => new Error("Email submission failed");
/** One public peer, verified implicit TLS, no pooling/proxy/fallback or URL content. */
/** No control characters in the subject, bounded sizes, and an Escalator message id. */
function assertSafeMessage(message: {
  subject: string;
  text: string;
  messageId: string;
}) {
  if (
    Array.from(message.subject).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    message.subject.length > 500 ||
    Buffer.byteLength(message.text) > 24576 ||
    !/^<[a-f0-9]{64}@escalator\.invalid>$/.test(message.messageId)
  )
    throw failure();
}
/** Every resolved address must be a public address of its stated family. */
function assertPublicAddresses(
  addresses: readonly { address: string; family: number }[],
) {
  if (
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some(
      (a) => isIP(a.address) !== a.family || !isPublicChannelAddress(a.address),
    )
  )
    throw failure();
}
/** Resolves once the TLS handshake succeeds with a verified certificate. */
function secureConnected(socket: TLSSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () =>
      socket.authorized ? resolve() : reject(failure()),
    );
    socket.once("error", () => reject(failure()));
    socket.once("close", () => reject(failure()));
  });
}
/** Accepted only when the server accepted exactly the one recipient and rejected none. */
function submissionOutcome(
  result: { accepted?: unknown[]; rejected?: unknown[] },
  to: string,
): "accepted" | "unknown" {
  return result.accepted?.length === 1 &&
    result.accepted[0] === to &&
    !result.rejected?.length
    ? "accepted"
    : "unknown";
}
/** Only explicit SMTP negative replies prove refusal; lost replies are ambiguous. */
function smtpFailureOutcome(error: unknown): "rejected" | "retry" | "unknown" {
  const code =
    error && typeof error === "object" && "responseCode" in error
      ? error.responseCode
      : undefined;
  if (typeof code !== "number" || !Number.isInteger(code)) return "unknown";
  if (code >= 500 && code <= 599) return "rejected";
  if (code >= 400 && code <= 499) return "retry";
  return "unknown";
}
export class PublicSmtpTransport implements EmailTransport {
  constructor(
    private readonly resolve: Resolve = (host) => lookup(host, { all: true }),
    private readonly socket: (
      options: ConnectionOptions,
    ) => TLSSocket = connect,
    private readonly mailer: typeof createTransport = createTransport,
  ) {}
  async send(
    credentials: Parameters<EmailTransport["send"]>[0],
    message: Parameters<EmailTransport["send"]>[1],
    signal: AbortSignal,
  ): ReturnType<EmailTransport["send"]> {
    const parsed = emailCredentialsSchema.safeParse(credentials);
    if (!parsed.success) throw failure();
    const c = parsed.data;
    assertSafeMessage(message);
    const controller = new AbortController();
    let peer: TLSSocket | undefined;
    let mail: ReturnType<typeof createTransport> | undefined;
    const abort = () => {
      controller.abort();
      peer?.destroy();
    };
    const timer = setTimeout(abort, 10000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const addresses = await this.bounded(
        this.resolve(c.host),
        controller.signal,
      );
      assertPublicAddresses(addresses);
      controller.signal.throwIfAborted();
      const address = addresses[0];
      const socket = this.socket({
        host: address.address,
        port: 465,
        servername: c.host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      });
      peer = socket;
      // Always consume socket errors; never emit provider details to logs.
      socket.on("error", () => {
        /* Error details deliberately discarded. */
      });
      await this.bounded(secureConnected(socket), controller.signal);
      controller.signal.throwIfAborted();
      mail = this.mailer({
        host: c.host,
        port: 465,
        secure: true,
        getSocket: (_options, callback) =>
          callback(null, { connection: socket, secured: true }),
        auth: { type: "login", user: c.username, pass: c.password },
        forceAuth: true,
        name: "escalator.invalid",
        pool: false,
        tls: {
          servername: c.host,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        connectionTimeout: 10000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        maxResponseSize: 65536,
        maxRecipients: 1,
        logger: false,
        debug: false,
        transactionLog: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const result = await this.bounded(
        mail.sendMail({
          from: { address: c.from, name: "" },
          to: [{ address: c.to, name: "" }],
          envelope: { from: c.from, to: [c.to] },
          subject: message.subject,
          text: message.text,
          messageId: message.messageId,
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return submissionOutcome(result, c.to);
    } catch (error) {
      if (controller.signal.aborted) return "unknown";
      return smtpFailureOutcome(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      peer?.destroy();
      mail?.close();
    }
  }
  private bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
