import { z } from "zod";
import { opaqueIdSchema } from "../../contracts/identity.js";
function isHttpLink(value: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export const acknowledgementLink = z
  .string()
  .url()
  .max(2048)
  .refine(isHttpLink);
export const channelNotificationSchema = z.strictObject({
  deliveryId: opaqueIdSchema,
  title: z.string().max(500),
  message: z.string().min(1).max(4096),
  acknowledgementUrl: acknowledgementLink,
});
export function decodeChannelSecret<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
): T | undefined {
  if (bytes.byteLength > 8192) return undefined;
  try {
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
