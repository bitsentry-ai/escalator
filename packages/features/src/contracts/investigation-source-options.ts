import { z } from "zod";
import { evidenceKindSchema } from "./investigation.js";
import {
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
} from "./identity.js";
export const investigationSourceOptionsInputSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  kind: evidenceKindSchema,
  limit: z.number().int().min(1).max(100).default(50),
  after: opaqueIdSchema.optional(),
});
export const investigationSourceOptionSchema = z.strictObject({
  kind: evidenceKindSchema,
  sourceId: opaqueIdSchema,
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
});
export const investigationSourceOptionsSchema = z.strictObject({
  items: z.array(investigationSourceOptionSchema).max(100),
  next: opaqueIdSchema.nullable(),
});
export type InvestigationSourceOptionsInput = z.input<
  typeof investigationSourceOptionsInputSchema
>;
export type InvestigationSourceOptionsQuery = z.output<
  typeof investigationSourceOptionsInputSchema
>;
export type InvestigationSourceOptions = z.output<
  typeof investigationSourceOptionsSchema
>;
