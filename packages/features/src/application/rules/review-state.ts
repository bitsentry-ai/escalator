import {
  ruleCatalogEntrySchema,
  ruleReviewReceiptSchema,
  ruleReviewFingerprintSchema,
  type RuleCatalogEntry,
  type RuleReviewReceipt,
  type RuleReviewFingerprint,
} from "../../contracts/rule-catalog.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import type { Actor } from "../../contracts/identity.js";
/** This pure check is necessary but not sufficient: the application also reads
 * the actor's current role, recomputes evidence, and writes on one transaction. */
export function assertCurrentRuleReview(
  rawEntry: RuleCatalogEntry,
  rawReceipt: RuleReviewReceipt,
  actor: Actor,
  rawCurrent: RuleReviewFingerprint,
  rawNow: string,
): void {
  const entry = ruleCatalogEntrySchema.parse(rawEntry),
    receipt = ruleReviewReceiptSchema.parse(rawReceipt),
    current = ruleReviewFingerprintSchema.parse(rawCurrent),
    now = utcTimestampSchema.parse(rawNow);
  if (
    entry.workspaceId !== actor.workspaceId ||
    receipt.workspaceId !== actor.workspaceId ||
    receipt.ruleId !== entry.id ||
    receipt.reviewedBy !== actor.responderId
  )
    throw new Error("Rule review belongs to another identity or scope");
  if (receipt.catalogRevision !== entry.revision)
    throw new Error("Rule changed after review");
  if (
    compareUtcTimestamps(now, receipt.createdAt) < 0 ||
    compareUtcTimestamps(now, receipt.expiresAt) >= 0
  )
    throw new Error("Rule review expired");
  if (JSON.stringify(receipt.fingerprint) !== JSON.stringify(current))
    throw new Error("Rule evidence changed after review");
}
