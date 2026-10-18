import { z } from "zod";
import { modelProfileSchema } from "./model-profile.js";
import {
  evidenceKindSchema,
  investigationLimitsSchema,
} from "./investigation.js";
import {
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
/** References select host-owned connections; neither SQL nor URLs are evidence selectors. */
export const investigationSourceSelectionSchema = z.strictObject({
  kind: evidenceKindSchema,
  sourceId: opaqueIdSchema,
  lookbackMs: z.number().int().min(1000).max(86400000),
  limit: z.number().int().min(1).max(100),
});
const sources = z
  .array(investigationSourceSelectionSchema)
  .max(32)
  .refine(
    (values) =>
      new Set(values.map((v) => `${v.kind}:${v.sourceId}`)).size ===
      values.length,
    "Evidence sources must be unique",
  );
const options = {
  enabled: z.boolean(),
  destination: modelProfileSchema.shape.destination,
  endpoint: modelProfileSchema.shape.endpoint,
  secretId: modelProfileSchema.shape.secretId,
  limits: investigationLimitsSchema,
  sources,
};
export const createInvestigationSettingsSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  ...options,
});
export const updateInvestigationSettingsSchema = z.strictObject({
  id: opaqueIdSchema,
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1),
  ...options,
});
export const investigationSettingsSchema = z
  .strictObject({
    profile: modelProfileSchema,
    enabled: z.boolean(),
    limits: investigationLimitsSchema,
    sources,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (v) => Date.parse(v.updatedAt) >= Date.parse(v.createdAt),
    "Invalid settings timestamps",
  );
export type InvestigationSettings = z.infer<typeof investigationSettingsSchema>;
export type InvestigationSourceSelection = z.infer<
  typeof investigationSourceSelectionSchema
>;
export type CreateInvestigationSettingsInput = z.infer<
  typeof createInvestigationSettingsSchema
>;
export type UpdateInvestigationSettingsInput = z.infer<
  typeof updateInvestigationSettingsSchema
>;
