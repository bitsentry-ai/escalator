import type { SecretStore } from "../../application/ports/secrets.js";
import type { ChannelHttpTransport } from "./ports.js";
import { discordCredentialsSchema } from "../../contracts/channel-credentials.js";
import {
  JsonNotificationChannel,
  boundedText,
  responseObject,
} from "./json-channel.js";
export class DiscordChannel extends JsonNotificationChannel<{ url: string }> {
  constructor(secrets: SecretStore, http: ChannelHttpTransport) {
    super(secrets, http, {
      credentials: discordCredentialsSchema,
      request: (n, c) => {
        const url = new URL(c.url);
        url.searchParams.set("wait", "true");
        return {
          url: url.href,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            allowed_mentions: { parse: [] },
            embeds: [
              {
                title: boundedText(n.title || "Acknowledge incident", 256),
                description: boundedText(n.message, 4096),
                url: n.acknowledgementUrl,
                footer: { text: "Open the title link to acknowledge" },
              },
            ],
          }),
        };
      },
      accepted: (status, body, c) => {
        const value = responseObject(body),
          parts = new URL(c.url).pathname.split("/");
        return (
          status === 200 &&
          typeof value?.id === "string" &&
          /^[0-9]{17,20}$/.test(value.id) &&
          value.webhook_id === parts[parts.length - 2]
        );
      },
    });
  }
}
