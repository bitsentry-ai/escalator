import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { detectionRuleSchema } from "./rules.js";
import { ruleTitleSchema } from "./rule-catalog.js";
import {
  portableRuleSchema,
  ruleImportMappingSchema,
} from "./portable-rule.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// The host binds the tenant, then the application validates evaluator invariants.
export const localRuleDefinitionSchema = z
  .strictObject(detectionRuleSchema.shape)
  .omit({ workspaceId: true });
export const createRuleDraftSchema = z.strictObject({
  title: ruleTitleSchema,
  definition: localRuleDefinitionSchema,
});
export const editRuleDraftSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
  definition: localRuleDefinitionSchema,
});
export const adoptRuleProposalSchema = z.strictObject({
  proposalId: opaqueIdSchema,
  title: ruleTitleSchema,
});
export const reviewRuleSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
  versionRevision: revision,
  mode: z.enum(["shadow", "active"]),
  runId: opaqueIdSchema.nullable(),
});
export const activateRuleSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  receiptId: opaqueIdSchema,
});
export const retireRuleSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
});
export const importRuleDraftSchema = z.strictObject({
  document: portableRuleSchema,
  mapping: ruleImportMappingSchema,
});
export const captureRuleSchema = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
  firstDecisionAt: utcTimestampSchema,
  lastDecisionAt: utcTimestampSchema,
});
export type CreateRuleDraftInput = z.infer<typeof createRuleDraftSchema>;
export type EditRuleDraftInput = z.infer<typeof editRuleDraftSchema>;
export type AdoptRuleProposalInput = z.infer<typeof adoptRuleProposalSchema>;
export type ReviewRuleInput = z.infer<typeof reviewRuleSchema>;
export type ActivateRuleInput = z.infer<typeof activateRuleSchema>;
export type RetireRuleInput = z.infer<typeof retireRuleSchema>;
export type ImportRuleDraftInput = z.infer<typeof importRuleDraftSchema>;
export type CaptureRuleInput = z.infer<typeof captureRuleSchema>;
