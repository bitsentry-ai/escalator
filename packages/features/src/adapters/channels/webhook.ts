import { webhookCredentialsSchema as credentials } from "../../contracts/channel-credentials.js";
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
/** The injected transport is responsible for validated, pinned egress, never raw fetch. */
export class WebhookChannel implements NotificationChannel {
  constructor(
    private readonly secrets: SecretStore,
    private readonly http: ChannelHttpTransport,
  ) {}
  async send(
    notification: ChannelNotification,
    use: SecretUse,
  ): Promise<ChannelSendResult> {
    let started = false;
    try {
      return await this.secrets.withSecret<ChannelSendResult>(
        use,
        async (bytes) => {
          const c = decodeChannelSecret(bytes, credentials);
          const n = channelNotificationSchema.safeParse(notification);
          if (!c || !n.success)
            return {
              outcome: "rejected",
              retryable: false,
              reason: "invalid_configuration",
            };
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "idempotency-key": n.data.deliveryId,
          };
          if (c.bearerToken) headers.authorization = `Bearer ${c.bearerToken}`;
          started = true;
          const result = await this.http.send({
            url: c.url,
            method: "POST",
            headers,
            body: JSON.stringify({ version: 1, ...n.data }),
            signal: use.signal,
          });
          if (result.status >= 200 && result.status < 300)
            return { outcome: "accepted", receiptId: null };
          if (
            result.status >= 400 &&
            result.status < 500 &&
            result.status !== 408
          )
            return {
              outcome: "rejected",
              retryable: result.status === 429,
              reason: "provider_rejected",
            };
          return { outcome: "unknown", retryable: true };
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
