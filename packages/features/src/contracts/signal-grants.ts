import { z } from "zod";
import { signalTokenSchema } from "./signal.js";
import { opaqueIdSchema } from "./identity.js";
const grant = signalTokenSchema.shape;
/** Safe inventory: neither the bearer token nor its digest is recoverable from this response. */
export const signalGrantSummarySchema = z.strictObject({
  id: grant.id,
  sourceId: grant.sourceId,
  scope: grant.scope,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt,
});
export const listSignalTokensSchema = z.strictObject({
  sourceId: opaqueIdSchema,
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const signalGrantPageSchema = z.strictObject({
  items: z.array(signalGrantSummarySchema).max(100),
  next: opaqueIdSchema.nullable(),
});
export type SignalGrantSummary = z.infer<typeof signalGrantSummarySchema>;
export type ListSignalTokensInput = z.input<typeof listSignalTokensSchema>;
