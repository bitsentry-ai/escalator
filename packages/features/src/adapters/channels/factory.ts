import { NtfyChannel } from "./ntfy.js";
import { SlackChannel } from "./slack.js";
import { DiscordChannel } from "./discord.js";
import type { RecipientDelivery } from "../../contracts/index.js";
import type { SecretStore } from "../../application/ports/secrets.js";
import type { ChannelHttpTransport, NotificationChannel } from "./ports.js";
import { PushoverChannel } from "./pushover.js";
import { WebhookChannel } from "./webhook.js";
/** Both hosts supply only their secret store and the validated egress transport. */
export function createPagingChannels(
  secrets: SecretStore,
  http: ChannelHttpTransport,
) {
  const webhook = new WebhookChannel(secrets, http);
  const ntfy = new NtfyChannel(secrets, http),
    slack = new SlackChannel(secrets, http),
    discord = new DiscordChannel(secrets, http);
  return {
    receipts: new PushoverChannel(secrets, http, {
      retrySeconds: 30,
      expireSeconds: 120,
    }),
    forDelivery(
      channel: RecipientDelivery["channel"],
      expireSeconds: number,
    ): NotificationChannel | undefined {
      switch (channel) {
        case "pushover":
          return new PushoverChannel(secrets, http, {
            retrySeconds: 30,
            expireSeconds,
          });
        case "webhook":
          return webhook;
        case "ntfy":
          return ntfy;
        case "slack":
          return slack;
        case "discord":
          return discord;
        default:
          return undefined;
      }
    },
  };
}
