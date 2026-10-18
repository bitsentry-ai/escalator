import { z } from "zod";
import {
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { ruleCatalogEntrySchema } from "./rule-catalog.js";
import { detectionRuleVersionSchema } from "./rule-state.js";
export const ruleCatalogListSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  after: opaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export const ruleCatalogIdSchema = z.strictObject({ id: opaqueIdSchema });
export const ruleCatalogHistoryQuerySchema = z.strictObject({
  ruleId: opaqueIdSchema,
  afterRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const ruleCatalogViewSchema = z
  .strictObject({
    entry: ruleCatalogEntrySchema,
    version: detectionRuleVersionSchema,
  })
  .refine(
    ({ entry, version }) =>
      entry.id === version.id &&
      entry.versionRevision === version.revision &&
      entry.workspaceId === version.definition.workspaceId &&
      entry.serviceId === version.definition.serviceId &&
      entry.environmentId === version.definition.environmentId,
    "Catalog version binding mismatch",
  );
export type RuleCatalogList = z.infer<typeof ruleCatalogListSchema>;
export type RuleCatalogHistoryQuery = z.infer<
  typeof ruleCatalogHistoryQuerySchema
>;
export type RuleCatalogView = z.infer<typeof ruleCatalogViewSchema>;
