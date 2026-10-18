import { z } from "zod";
import {
  opaqueIdSchema,
  responderIdSchema,
  workspaceIdSchema,
} from "./identity.js";

export const pagingChannelSchema = z.enum([
  "pushover",
  "webhook",
  "ntfy",
  "slack",
  "discord",
  "email",
]);
export type PagingChannel = z.infer<typeof pagingChannelSchema>;

/** Provider destinations remain secret; routing retains an opaque reference only. */
export const pagingContactSchema = z.strictObject({
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  responderId: responderIdSchema,
  channel: pagingChannelSchema,
  secretId: opaqueIdSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1000),
});
export type PagingContact = z.infer<typeof pagingContactSchema>;
