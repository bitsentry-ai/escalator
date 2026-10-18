import { z } from "zod";

function endpoint(value: string, kind: "ntfy" | "slack" | "discord") {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== "443")
    )
      return false;
    if (kind === "ntfy") return url.pathname === "/";
    if (kind === "slack")
      return (
        url.hostname === "hooks.slack.com" &&
        /^\/services\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(
          url.pathname,
        )
      );
    return (
      url.hostname === "discord.com" &&
      /^\/api\/(?:v10\/)?webhooks\/[0-9]{17,20}\/[A-Za-z0-9._-]{16,256}$/.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
const url = (kind: "ntfy" | "slack" | "discord") =>
  z
    .string()
    .url()
    .max(2048)
    .refine((value) => endpoint(value, kind));
export const ntfyCredentialsSchema = z.strictObject({
  url: url("ntfy"),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  bearerToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});
export const slackCredentialsSchema = z.strictObject({ url: url("slack") });
export const discordCredentialsSchema = z.strictObject({ url: url("discord") });

const key = z.string().regex(/^[A-Za-z0-9]{30}$/);
export const pushoverCredentialsSchema = z.strictObject({
  token: key,
  user: key,
  device: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,25}$/)
    .optional(),
});
export const webhookCredentialsSchema = z.strictObject({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  bearerToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});

export const createChannelSecretSchema = z.discriminatedUnion("channel", [
  z.strictObject({
    name: z.string().trim().min(1).max(120),
    channel: z.literal("ntfy"),
    credentials: ntfyCredentialsSchema,
  }),
  z.strictObject({
    name: z.string().trim().min(1).max(120),
    channel: z.literal("slack"),
    credentials: slackCredentialsSchema,
  }),
  z.strictObject({
    name: z.string().trim().min(1).max(120),
    channel: z.literal("discord"),
    credentials: discordCredentialsSchema,
  }),
  z.strictObject({
    name: z.string().trim().min(1).max(120),
    channel: z.literal("pushover"),
    credentials: pushoverCredentialsSchema,
  }),
  z.strictObject({
    name: z.string().trim().min(1).max(120),
    channel: z.literal("webhook"),
    credentials: webhookCredentialsSchema,
  }),
]);
export type CreateChannelSecretInput = z.input<
  typeof createChannelSecretSchema
>;

export const channelSecretOptionsSchema = z.strictObject({
  available: z.boolean(),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(120),
      }),
    )
    .max(50),
  next: z.string().min(1).max(200).nullable(),
});
export type ChannelSecretOptions = z.infer<typeof channelSecretOptionsSchema>;
