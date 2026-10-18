import { z } from "zod";
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
