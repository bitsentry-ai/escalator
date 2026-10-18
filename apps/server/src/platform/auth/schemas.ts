import { z } from "zod";
import {
  opaqueIdSchema,
  responderSchema,
  workspaceSchema,
} from "@bitsentry-escalator/features/contracts";
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const loginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const accountProofSchema = z.strictObject({
  accountId: opaqueIdSchema,
  authVersion: z.number().int().min(1).max(2147483647),
});
/** Internal persistence DTO; public registration accepts a password and hashes it first. */
export const persistedRegistrationSchema = z.strictObject({
  tokenDigest: digestSchema,
  login: loginSchema,
  passwordHash: z.string().min(1).max(512),
  displayName: responderSchema.shape.displayName,
  timeZone: responderSchema.shape.timeZone,
});
export const workspaceNameSchema = workspaceSchema.shape.name;
