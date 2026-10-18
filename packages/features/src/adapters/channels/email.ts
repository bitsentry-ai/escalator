import { createHash } from "node:crypto";
import type {
  SecretStore,
  SecretUse,
} from "../../application/ports/secrets.js";
import {
  emailCredentialsSchema,
  type EmailCredentials,
} from "../../contracts/email-credentials.js";
import type {
  ChannelNotification,
  ChannelSendResult,
  NotificationChannel,
} from "./ports.js";
import {
  channelNotificationSchema,
  decodeChannelSecret,
} from "./validation.js";
export interface EmailTransport {
  /** Must bound total duration and close the pinned socket when aborted. */
  send(
    credentials: EmailCredentials,
    message: { subject: string; text: string; messageId: string },
    signal: AbortSignal,
  ): Promise<"accepted" | "rejected" | "retry" | "unknown">;
}
export class EmailChannel implements NotificationChannel {
  constructor(
    private readonly secrets: SecretStore,
    private readonly transport: EmailTransport,
  ) {}
  async send(
    notification: ChannelNotification,
    use: SecretUse,
  ): Promise<ChannelSendResult> {
    const parsed = channelNotificationSchema.safeParse(notification);
    if (
      !parsed.success ||
      Array.from(notification.title).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
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
          const credentials = decodeChannelSecret(
            bytes,
            emailCredentialsSchema,
          );
          const link = new URL(parsed.data.acknowledgementUrl);
          if (
            !credentials ||
            link.username ||
            link.password ||
            link.href.length > 2048
          )
            return {
              outcome: "rejected",
              retryable: false,
              reason: "invalid_configuration",
            };
          if (use.signal.aborted)
            return { outcome: "unknown", retryable: true };
          const digest = createHash("sha256")
            .update(JSON.stringify([use.workspaceId, notification.deliveryId]))
            .digest("hex");
          started = true;
          const result = await this.transport.send(
            credentials,
            {
              subject: notification.title,
              text: notification.message + "\n\n" + link.href,
              messageId: `<${digest}@escalator.invalid>`,
            },
            use.signal,
          );
          if (use.signal.aborted)
            return { outcome: "unknown", retryable: true };
          if (result === "accepted")
            return { outcome: "accepted", receiptId: null };
          if (result === "rejected" || result === "retry")
            return {
              outcome: "rejected",
              retryable: result === "retry",
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
