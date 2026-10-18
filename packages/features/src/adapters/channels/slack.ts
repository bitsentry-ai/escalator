import type { SecretStore } from "../../application/ports/secrets.js";
import type { ChannelHttpTransport } from "./ports.js";
import { slackCredentialsSchema } from "../../contracts/channel-credentials.js";
import { JsonNotificationChannel, boundedText } from "./json-channel.js";
export class SlackChannel extends JsonNotificationChannel<{ url: string }> {
  constructor(secrets: SecretStore, http: ChannelHttpTransport) {
    super(secrets, http, {
      credentials: slackCredentialsSchema,
      request: (n, c) => {
        const text = boundedText(n.message, 4096, 10000),
          pieces: string[] = [];
        let piece = "";
        for (const char of text) {
          if (piece.length + char.length > 2000) {
            pieces.push(piece);
            piece = "";
          }
          piece += char;
        }
        if (piece) pieces.push(piece);
        const link = new URL(n.acknowledgementUrl).href.replace(
          /[<>|]/g,
          (char) => encodeURIComponent(char),
        );
        const plain = (value: string) => ({
          type: "section",
          text: { type: "plain_text", text: value, emoji: false },
        });
        return {
          url: c.url,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Escalator incident notification",
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              plain(boundedText(n.title || "Incident", 500, 1000)),
              ...pieces.map(plain),
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `<${link}|Acknowledge incident>`,
                },
              },
            ],
          }),
        };
      },
      accepted: (status, body) => status === 200 && body.trim() === "ok",
    });
  }
}
