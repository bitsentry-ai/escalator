import { z } from "zod";
const mailbox = z
  .string()
  .email()
  .max(254)
  .regex(
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/,
  )
  .transform((value) => {
    const at = value.lastIndexOf("@");
    return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
  });
/** SMTP submission only: fixed implicit TLS, one recipient, no URL configuration. */
export const emailCredentialsSchema = z
  .strictObject({
    host: z
      .string()
      .max(253)
      .regex(
        /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
      ),
    port: z.literal(465),
    username: z
      .string()
      .min(1)
      .max(320)
      .refine((v) =>
        Array.from(v).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        ),
      ),
    password: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (v) =>
          !["\0", "\r", "\n"].some((char) => v.includes(char)) &&
          new TextEncoder().encode(v).length <= 4096,
      ),
    from: mailbox,
    to: mailbox,
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8192,
  );
export type EmailCredentials = z.infer<typeof emailCredentialsSchema>;
