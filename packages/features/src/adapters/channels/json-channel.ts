import type { z } from "zod";
import type {
  SecretStore,
  SecretUse,
} from "../../application/ports/secrets.js";
import type {
  ChannelHttpTransport,
  ChannelNotification,
  ChannelSendResult,
  NotificationChannel,
} from "./ports.js";
import {
  channelNotificationSchema,
  decodeChannelSecret,
} from "./validation.js";
type Request = Omit<
  Parameters<ChannelHttpTransport["send"]>[0],
  "signal" | "method"
>;
/** Provider payloads are transient; never return or log provider bodies or credentials. */
export class JsonNotificationChannel<C> implements NotificationChannel {
  constructor(
    private readonly secrets: SecretStore,
    private readonly http: ChannelHttpTransport,
    private readonly protocol: {
      credentials: z.ZodType<C>;
      request(n: ChannelNotification, c: C): Request;
      accepted(status: number, body: string, c: C): boolean;
    },
  ) {}
  async send(
    notification: ChannelNotification,
    use: SecretUse,
  ): Promise<ChannelSendResult> {
    const n = channelNotificationSchema.safeParse(notification);
    if (!n.success)
      return {
        outcome: "rejected",
        retryable: false,
        reason: "invalid_configuration",
      };
    if (use.signal.aborted) return { outcome: "unknown", retryable: true };
    let started = false;
    try {
      return await this.secrets.withSecret<ChannelSendResult>(
        use,
        async (bytes) => {
          const c = decodeChannelSecret(bytes, this.protocol.credentials);
          if (!c)
            return {
              outcome: "rejected",
              retryable: false,
              reason: "invalid_configuration",
            };
          if (use.signal.aborted)
            return { outcome: "unknown", retryable: true };
          const acknowledgement = new URL(n.data.acknowledgementUrl);
          if (
            acknowledgement.href.length > 2048 ||
            acknowledgement.username ||
            acknowledgement.password
          )
            return {
              outcome: "rejected",
              retryable: false,
              reason: "invalid_configuration",
            };
          const request = this.protocol.request(
            { ...n.data, acknowledgementUrl: acknowledgement.href },
            c,
          );
          if (Buffer.byteLength(request.body ?? "") > 16384)
            return {
              outcome: "rejected",
              retryable: false,
              reason: "invalid_configuration",
            };
          try {
            started = true;
            const response = await this.http.send({
              ...request,
              method: "POST",
              signal: use.signal,
            });
            if (use.signal.aborted)
              return { outcome: "unknown", retryable: true };
            if (
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 408
            )
              return {
                outcome: "rejected",
                retryable: response.status === 429,
                reason: "provider_rejected",
              };
            if (
              response.status >= 200 &&
              response.status < 300 &&
              Buffer.byteLength(response.body) <= 65536 &&
              this.protocol.accepted(response.status, response.body, c)
            )
              return { outcome: "accepted", receiptId: null };
            return { outcome: "unknown", retryable: true };
          } finally {
            // Release references held by this adapter after the transport settles.
            request.url = "";
            request.body = "";
            request.headers = {};
          }
        },
      );
    } catch {
      return started
        ? { outcome: "unknown", retryable: true }
        : {
            outcome: "rejected",
            retryable: true,
            reason: "secret_unavailable",
          };
    }
  }
}
export function responseObject(
  body: string,
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Preserve whole Unicode code points, including when provider limits are byte based. */
export function boundedText(
  input: string,
  maxCharacters: number,
  maxBytes = 16384,
): string {
  const wellFormed = Buffer.from(input).toString("utf8");
  let output = "",
    bytes = 0,
    count = 0;
  for (const char of wellFormed) {
    const size = Buffer.byteLength(char);
    if (count + char.length > maxCharacters || bytes + size > maxBytes) break;
    output += char;
    bytes += size;
    count += char.length;
  }
  return output;
}
