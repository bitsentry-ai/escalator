import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  SecretStore,
  SecretUse,
} from "../../application/ports/secrets.js";
import type {
  ChannelHttpTransport,
  ChannelNotification,
  ChannelReceiptResult,
  ChannelSendResult,
  ReceiptChannel,
} from "./ports.js";
import {
  acknowledgementLink,
  channelNotificationSchema,
  decodeChannelSecret,
} from "./validation.js";
const key = z.string().regex(/^[A-Za-z0-9]{30}$/);
const credentials = z.strictObject({
  token: key,
  user: key,
  device: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,25}$/)
    .optional(),
});
const response = z.object({ status: z.literal(1), receipt: key });
const receipt = z.object({
  status: z.literal(1),
  acknowledged: z.union([z.literal(0), z.literal(1)]),
  acknowledged_at: z.number().int().nonnegative(),
  acknowledged_by: z.string().optional(),
  expired: z.union([z.literal(0), z.literal(1)]),
});
const ok = z.object({ status: z.literal(1) });
const unknown = (): ChannelSendResult => ({
  outcome: "unknown",
  retryable: true,
});
const rejected = (
  reason: "invalid_configuration" | "secret_unavailable" | "provider_rejected",
  retryable = false,
): ChannelSendResult => ({ outcome: "rejected", retryable, reason });
const tag = (scope: string, deliveryId: string) =>
  "escalator_" +
  createHash("sha256")
    .update(JSON.stringify([scope, deliveryId]))
    .digest("hex");
function json(body: string): unknown {
  if (body.length > 65_536) throw new Error("Oversized provider response");
  return JSON.parse(body) as unknown;
}
/** Credentials are read only inside the already-authorized secret callback. */
export class PushoverChannel implements ReceiptChannel {
  private readonly emergency: Readonly<{
    retrySeconds: number;
    expireSeconds: number;
  }>;
  constructor(
    private readonly secrets: SecretStore,
    private readonly http: ChannelHttpTransport,
    emergency: { retrySeconds: number; expireSeconds: number },
  ) {
    this.emergency = Object.freeze(
      z
        .strictObject({
          retrySeconds: z.number().int().min(30).max(10800),
          expireSeconds: z.number().int().min(1).max(10800),
        })
        .parse(emergency),
    );
  }
  async send(
    notification: ChannelNotification,
    use: SecretUse,
  ): Promise<ChannelSendResult> {
    let started = false;
    try {
      return await this.secrets.withSecret<ChannelSendResult>(
        use,
        async (bytes) => {
          const parsed = decodeChannelSecret(bytes, credentials);
          if (!parsed) return rejected("invalid_configuration");
          const n = channelNotificationSchema
            .extend({
              title: z.string().max(250),
              message: z.string().min(1).max(1024),
              acknowledgementUrl: acknowledgementLink.max(512),
            })
            .safeParse(notification);
          if (!n.success) return rejected("invalid_configuration");
          const body = new URLSearchParams({
            token: parsed.token,
            user: parsed.user,
            title: n.data.title,
            message: n.data.message,
            url: n.data.acknowledgementUrl,
            url_title: "Acknowledge",
            priority: "2",
            retry: String(this.emergency.retrySeconds),
            expire: String(this.emergency.expireSeconds),
            tags: tag(use.workspaceId, n.data.deliveryId),
          });
          if (parsed.device) body.set("device", parsed.device);
          started = true;
          const result = await this.http.send({
            url: "https://api.pushover.net/1/messages.json",
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: use.signal,
          });
          if (result.status === 408) return unknown();
          if (result.status >= 400 && result.status < 500)
            return rejected("provider_rejected", result.status === 429);
          if (result.status !== 200) return unknown();
          const decoded = json(result.body);
          if (z.object({ status: z.literal(0) }).safeParse(decoded).success)
            return rejected("provider_rejected");
          const value = response.safeParse(decoded);
          return value.success
            ? { outcome: "accepted", receiptId: value.data.receipt }
            : unknown();
        },
      );
    } catch {
      return started ? unknown() : rejected("secret_unavailable", true);
    }
  }
  async inspect(
    receiptId: string,
    use: SecretUse,
  ): Promise<ChannelReceiptResult> {
    if (!key.safeParse(receiptId).success) return { state: "unknown" };
    try {
      return await this.secrets.withSecret<ChannelReceiptResult>(
        use,
        async (bytes) => {
          const c = decodeChannelSecret(bytes, credentials);
          if (!c) return { state: "unknown" };
          const result = await this.http.send({
            url: `https://api.pushover.net/1/receipts/${receiptId}.json?token=${c.token}`,
            method: "GET",
            headers: {},
            signal: use.signal,
          });
          if (result.status !== 200) return { state: "unknown" };
          const value = receipt.safeParse(json(result.body));
          if (!value.success) return { state: "unknown" };
          if (value.data.acknowledged === 1) {
            if (
              value.data.acknowledged_by !== c.user ||
              value.data.acknowledged_at <= 0
            )
              return { state: "unknown" };
            return {
              state: "acknowledged",
              acknowledgedAt: new Date(
                value.data.acknowledged_at * 1000,
              ).toISOString(),
            };
          }
          return { state: value.data.expired === 1 ? "expired" : "pending" };
        },
      );
    } catch {
      return { state: "unknown" };
    }
  }
  async cancel(
    deliveryId: string,
    use: SecretUse,
  ): Promise<"cancelled" | "unknown"> {
    if (!deliveryId || deliveryId.length > 128) return "unknown";
    try {
      return await this.secrets.withSecret<"cancelled" | "unknown">(
        use,
        async (bytes) => {
          const c = decodeChannelSecret(bytes, credentials);
          if (!c) return "unknown";
          const result = await this.http.send({
            url: `https://api.pushover.net/1/receipts/cancel_by_tag/${tag(use.workspaceId, deliveryId)}.json`,
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: c.token }).toString(),
            signal: use.signal,
          });
          return result.status === 200 &&
            ok.safeParse(json(result.body)).success
            ? "cancelled"
            : "unknown";
        },
      );
    } catch {
      return "unknown";
    }
  }
}
