import { z } from "zod";
import {
  environmentIdSchema,
  responderIdSchema,
  roleSchema,
  serviceIdSchema,
  workspaceIdSchema,
} from "./identity.js";

export const utcTimestampSchema = z.string().datetime();
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    if (/^[+-]/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Expected a supported IANA timezone");
const nameSchema = z.string().trim().min(1).max(200);
const keySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const timestamps = {
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
};
const ordered = (value: { createdAt: string; updatedAt: string }) =>
  Date.parse(value.updatedAt) >= Date.parse(value.createdAt);
const chronology = {
  message: "updatedAt precedes createdAt",
  path: ["updatedAt"],
};

export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    name: nameSchema,
    ...timestamps,
  })
  .strict()
  .refine(ordered, chronology);
export const serviceSchema = z
  .object({
    id: serviceIdSchema,
    workspaceId: workspaceIdSchema,
    name: nameSchema,
    key: keySchema,
    owningTeam: nameSchema,
    enabled: z.boolean(),
    ...timestamps,
  })
  .strict()
  .refine(ordered, chronology);
export const environmentSchema = z
  .object({
    id: environmentIdSchema,
    workspaceId: workspaceIdSchema,
    name: nameSchema,
    key: keySchema,
    isProduction: z.boolean(),
    ...timestamps,
  })
  .strict()
  .refine(ordered, chronology);
export const responderSchema = z
  .object({
    id: responderIdSchema,
    workspaceId: workspaceIdSchema,
    // Dashboard maps its integer user ID to a string in its identity adapter.
    hostUserId: z.string().min(1).max(200),
    displayName: nameSchema,
    timeZone: timeZoneSchema,
    role: roleSchema,
    enabled: z.boolean(),
    ...timestamps,
  })
  .strict()
  .refine(ordered, chronology);
export type Workspace = z.infer<typeof workspaceSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type Responder = z.infer<typeof responderSchema>;

/** Domain evaluation uses this clock; durable persistence deadlines use DB time. */
export interface Clock {
  now(): Date;
}
