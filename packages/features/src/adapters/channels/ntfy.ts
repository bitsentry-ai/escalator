import type { SecretStore } from "../../application/ports/secrets.js";
import type { ChannelHttpTransport } from "./ports.js";
import { ntfyCredentialsSchema } from "../../contracts/channel-credentials.js";
import {
  JsonNotificationChannel,
  boundedText,
  responseObject,
} from "./json-channel.js";
export class NtfyChannel extends JsonNotificationChannel<{
  url: string;
  topic: string;
  bearerToken?: string;
}> {
  constructor(secrets: SecretStore, http: ChannelHttpTransport) {
    super(secrets, http, {
      credentials: ntfyCredentialsSchema,
      request: (n, c) => ({
        url: c.url,
        headers: {
          "content-type": "application/json",
          ...(c.bearerToken
            ? { authorization: `Bearer ${c.bearerToken}` }
            : {}),
        },
        body: JSON.stringify({
          topic: c.topic,
          title: boundedText(n.title, 200, 800),
          message: boundedText(n.message, 4096, 4096),
          priority: 5,
          click: n.acknowledgementUrl,
          actions: [
            { action: "view", label: "Acknowledge", url: n.acknowledgementUrl },
          ],
        }),
      }),
      accepted: (status, body, c) => {
        const value = responseObject(body);
        return (
          status === 200 &&
          value?.event === "message" &&
          value.topic === c.topic &&
          typeof value.id === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(value.id)
        );
      },
    });
  }
}
