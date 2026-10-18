import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { storableText, unicodeMessage } from "./text.js";
import { compareUtcTimestamps } from "./timestamps.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ruleTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(storableText, unicodeMessage);
export const ruleCatalogStatusSchema = z.enum([
  "draft",
  "shadow",
  "active",
  "retired",
]);
/** Content revisions remain immutable in the existing version table. Catalog
 * revisions guard human mutations; generation identifies a fresh runtime epoch. */
export const ruleCatalogEntrySchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    title: ruleTitleSchema,
    revision,
    versionRevision: revision,
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: ruleCatalogStatusSchema,
    originProposalId: opaqueIdSchema.nullable(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .superRefine((row, c) => {
    if (compareUtcTimestamps(row.createdAt, row.updatedAt) > 0)
      c.addIssue({
        code: "custom",
        message: "Catalog update precedes creation",
      });
    if (["shadow", "active"].includes(row.status) && row.generation === 0)
      c.addIssue({
        code: "custom",
        message: "Live rules require an activation epoch",
      });
  });
export type RuleCatalogEntry = z.infer<typeof ruleCatalogEntrySchema>;
/** Host-computed hashes: no client-supplied source/configuration facts are trusted. */
export const ruleReviewFingerprintSchema = z.strictObject({
  versionHash: hash,
  measurementHash: hash,
  coverageHash: hash,
  policyHash: hash,
  labelHash: hash,
  reportHash: hash.nullable(),
});
export type RuleReviewFingerprint = z.infer<typeof ruleReviewFingerprintSchema>;
export const ruleReviewReceiptSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    ruleId: opaqueIdSchema,
    catalogRevision: revision,
    versionRevision: revision,
    reviewedBy: responderIdSchema,
    mode: z.enum(["shadow", "active"]),
    runId: opaqueIdSchema.nullable(),
    fingerprint: ruleReviewFingerprintSchema,
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
  })
  .superRefine((row, c) => {
    const lifetime = Date.parse(row.expiresAt) - Date.parse(row.createdAt);
    if (lifetime <= 0 || lifetime > 900000)
      c.addIssue({
        code: "custom",
        message: "Review expires within fifteen minutes",
      });
    if (row.mode === "active" && (!row.runId || !row.fingerprint.reportHash))
      c.addIssue({
        code: "custom",
        message: "Active review requires a sealed report",
      });
    if ((row.runId === null) !== (row.fingerprint.reportHash === null))
      c.addIssue({ code: "custom", message: "Review report binding mismatch" });
  });
export type RuleReviewReceipt = z.infer<typeof ruleReviewReceiptSchema>;
export const ruleActivationHistorySchema = z.strictObject({
  id: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  ruleId: opaqueIdSchema,
  catalogRevision: revision,
  versionRevision: revision,
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  action: z.enum([
    "drafted",
    "revised",
    "shadowed",
    "activated",
    "retired",
    "rolled_back",
  ]),
  actorId: responderIdSchema,
  previousVersionRevision: revision.nullable(),
  previousIncidentId: opaqueIdSchema.nullable(),
  receiptId: opaqueIdSchema.nullable(),
  recordedAt: utcTimestampSchema,
});
export type RuleActivationHistory = z.infer<typeof ruleActivationHistorySchema>;
