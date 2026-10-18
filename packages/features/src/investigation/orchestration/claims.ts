import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  investigationScopeSchema,
  investigationLimitsSchema,
  evidenceQuerySchema,
  investigationEvidenceSchema,
  investigationReportSchema,
  investigationUsageSchema,
  unavailableEvidenceSchema,
  type InvestigationUsage,
} from "../../contracts/index.js";
import type {
  InvestigationClaim,
  InvestigationRunResult,
  InvestigationTraceEvent,
} from "../ports/index.js";
/** Serialization validation only. The host must authenticate runtime/scope and the DB lease. */
export const investigationClaimSchema = z.strictObject({
  id: opaqueIdSchema,
  scope: investigationScopeSchema,
  runtimeId: opaqueIdSchema,
  claimToken: opaqueIdSchema,
  leaseExpiresAt: utcTimestampSchema,
  attempt: z.number().int().min(1),
  profileId: opaqueIdSchema,
  limits: investigationLimitsSchema,
  sources: z.array(evidenceQuerySchema).max(32),
});
const resultSchema = z.strictObject({
  report: investigationReportSchema,
  evidence: z.array(investigationEvidenceSchema).max(128),
});
export class InvalidInvestigationResult extends Error {
  constructor() {
    super("Investigation result does not match its claim");
  }
}
/** Returns a detached snapshot; use the persisted claim, never request-body authority.
 * Bound HTTP/database materialization before calling. This checks shape/provenance,
 * not truth of a model's diagnosis or the host's configured destination authorization.
 */
export function validateInvestigationResult(
  claimInput: InvestigationClaim,
  input: unknown,
): InvestigationRunResult {
  const claim = investigationClaimSchema.parse(claimInput);
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new InvalidInvestigationResult();
  const result = parsed.data;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (result.report.id !== claim.id || !same(result.report.scope, claim.scope))
    throw new InvalidInvestigationResult();
  const { usage } = result.report;
  validateUsage(claim, usage);
  const refs = new Map(result.report.evidence.map((ref) => [ref.id, ref]));
  const ids = new Set<string>();
  if (refs.size !== result.evidence.length)
    throw new InvalidInvestigationResult();
  const bytes = result.evidence.length
    ? Buffer.byteLength(JSON.stringify(result.evidence), "utf8")
    : 0;
  if (bytes > usage.evidenceBytes) throw new InvalidInvestigationResult();
  for (const item of result.evidence) {
    const ref = item.reference;
    if (
      ids.has(ref.id) ||
      !same(item.scope, claim.scope) ||
      !same(refs.get(ref.id), ref) ||
      !item.text.trim()
    )
      throw new InvalidInvestigationResult();
    ids.add(ref.id);
    if (
      !claim.sources.some(
        (query) =>
          query.kind === ref.kind &&
          query.sourceId === ref.sourceId &&
          same(query.window, item.window),
      )
    )
      throw new InvalidInvestigationResult();
    if (
      Date.parse(ref.observedAt) < Date.parse(item.window.from) ||
      Date.parse(ref.observedAt) > Date.parse(item.window.to) ||
      Date.parse(ref.receivedAt) > Date.parse(item.collectedAt) ||
      Date.parse(ref.observedAt) > Date.parse(item.collectedAt)
    )
      throw new InvalidInvestigationResult();
  }
  for (const unavailable of result.report.unavailable)
    if (!claim.sources.some((query) => same(query, unavailable.query)))
      throw new InvalidInvestigationResult();
  if (
    result.report.status === "complete" &&
    (result.report.unavailable.length ||
      result.evidence.some((item) => item.truncated))
  )
    throw new InvalidInvestigationResult();
  return result;
}

function validateUsage(
  claim: InvestigationClaim,
  usage: InvestigationUsage,
): void {
  for (const [used, cap] of [
    [usage.modelCalls, claim.limits.maxModelCalls],
    [usage.evidenceReads, claim.limits.maxEvidenceReads],
    [usage.evidenceBytes, claim.limits.maxEvidenceBytes],
    [usage.outputTokens, claim.limits.maxOutputTokens],
    [usage.traceEvents, claim.limits.maxTraceEvents],
  ])
    if (used > cap) throw new InvalidInvestigationResult();
}

const traceSchema = z.strictObject({
  sequence: z.number().int().min(0).max(127),
  at: utcTimestampSchema,
  kind: z.enum([
    "started",
    "evidence_read",
    "model_call",
    "budget_exhausted",
    "cancelled",
    "finished",
  ]),
  evidenceIds: z.array(opaqueIdSchema).max(128),
  unavailableReason: unavailableEvidenceSchema.shape.reason.optional(),
  usage: investigationUsageSchema,
});
/** Validate bounded metadata, never raw prompts. Persistence must fence the live claim
 * and enforce idempotent sequence/content matching in the same transaction. */
export function validateInvestigationTrace(
  claimInput: InvestigationClaim,
  input: unknown,
): InvestigationTraceEvent {
  const claim = investigationClaimSchema.parse(claimInput);
  const parsed = traceSchema.safeParse(input);
  if (!parsed.success) throw new InvalidInvestigationResult();
  const event = parsed.data;
  validateUsage(claim, event.usage);
  if (
    event.sequence >= claim.limits.maxTraceEvents ||
    event.usage.traceEvents !== event.sequence + 1 ||
    new Set(event.evidenceIds).size !== event.evidenceIds.length
  )
    throw new InvalidInvestigationResult();
  return event;
}
