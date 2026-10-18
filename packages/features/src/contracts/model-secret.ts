import { z } from "zod";
import { storableText, unicodeMessage } from "./text.js";
/** The canonical model credential is an HTTP bearer bundle compatible with the host broker. */
export const modelKeyBundleSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
});
export const createModelSecretSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).refine(storableText, unicodeMessage),
  credentials: z.strictObject({ key: modelKeyBundleSchema.shape.token }),
});
export type CreateModelSecretInput = z.input<typeof createModelSecretSchema>;
