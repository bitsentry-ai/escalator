import { z } from "zod";
export const acknowledgementResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("invalid") }).strict(),
  z
    .object({ state: z.literal("open"), pageId: z.string(), title: z.string() })
    .strict(),
  z
    .object({
      state: z.literal("acknowledged"),
      pageId: z.string(),
      ownerId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal("resolved"),
      pageId: z.string(),
      ownerId: z.string().nullable(),
    })
    .strict(),
]);
export type AcknowledgementResult = z.infer<typeof acknowledgementResultSchema>;
