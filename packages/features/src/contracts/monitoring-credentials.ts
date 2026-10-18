import { z } from "zod";
import { storableText, unicodeMessage } from "./text.js";
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(storableText, unicodeMessage);
const headerValue = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x20-\x7e]+$/);
/** Write-only values. Hosts return only an opaque reference and name. */
export const createMonitoringSecretSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    name,
    kind: z.literal("http-probe"),
    credentials: z.strictObject({
      header: z.enum(["authorization", "x-api-key"]),
      value: headerValue,
    }),
  }),
  z.strictObject({
    name,
    kind: z.literal("metrics"),
    credentials: z.strictObject({ authorization: headerValue }),
  }),
  z.strictObject({
    name,
    kind: z.literal("provider-signing"),
    credentials: z.strictObject({
      key: z
        .string()
        .min(1)
        .max(4096)
        .refine(storableText, unicodeMessage)
        .refine(
          (value) => new TextEncoder().encode(value).byteLength <= 4096,
          "Signing key exceeds the byte limit",
        ),
    }),
  }),
]);
export type CreateMonitoringSecretInput = z.input<
  typeof createMonitoringSecretSchema
>;
export type MonitoringSecretKind = CreateMonitoringSecretInput["kind"];
