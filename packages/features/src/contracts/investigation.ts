import { z } from "zod";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
/** Scope is captured from the incident by its host, never supplied by model output. */
export const investigationScopeSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  incidentId: opaqueIdSchema,
});
export const evidenceKindSchema = z.enum([
  "probe",
  "alert",
  "metric",
  "log",
  "deployment",
  "git_diff",
]);
export const evidenceWindowSchema = z
  .strictObject({ from: utcTimestampSchema, to: utcTimestampSchema })
  .refine((v) => {
    const span = Date.parse(v.to) - Date.parse(v.from);
    return span >= 0 && span <= 86400000;
  }, "Evidence window must be within 24 hours");
/** A source ID selects a configured, scoped reader; it is not a URL or query expression. */
export const evidenceQuerySchema = z.strictObject({
  kind: evidenceKindSchema,
  sourceId: opaqueIdSchema,
  window: evidenceWindowSchema,
  limit: z.number().int().min(1).max(100),
});
export const evidenceReferenceSchema = z.strictObject({
  id: opaqueIdSchema,
  kind: evidenceKindSchema,
  sourceId: opaqueIdSchema,
  observedAt: utcTimestampSchema,
  receivedAt: utcTimestampSchema,
});
export const investigationEvidenceSchema = z.strictObject({
  reference: evidenceReferenceSchema,
  scope: investigationScopeSchema,
  collectedAt: utcTimestampSchema,
  window: evidenceWindowSchema,
  text: z.string().max(16384),
  truncated: z.boolean(),
});
export const unavailableEvidenceSchema = z.strictObject({
  query: evidenceQuerySchema,
  reason: z.enum([
    "not_configured",
    "not_authorized",
    "not_found",
    "timeout",
    "unreachable",
    "invalid_response",
    "budget_exhausted",
    "cancelled",
  ]),
});
export const modelProviderSchema = z.enum([
  "gemini",
  "groq",
  "openai",
  "kilocode",
  "openrouter",
  "anthropic",
  "ollama",
]);
/** Display metadata has no credentials. Local destinations never authorize a remote fallback. */
export const modelDestinationSchema = z.strictObject({
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(200),
  location: z.enum(["local", "remote"]),
  origin: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === "/"
        );
      } catch {
        return false;
      }
    }, "Expected credential-free HTTP origin"),
});
export const investigationLimitsSchema = z.strictObject({
  maxDurationMs: z.number().int().min(1000).max(600000),
  maxModelCalls: z.number().int().min(1).max(10),
  maxEvidenceReads: z.number().int().min(1).max(32),
  maxEvidenceBytes: z.number().int().min(1024).max(262144),
  maxOutputTokens: z.number().int().min(128).max(16384),
  maxTraceEvents: z.number().int().min(1).max(128),
});
/** Charged budget units; output tokens may be conservatively reserved, not exact provider-reported usage. */
export const investigationUsageSchema = z.strictObject({
  modelCalls: z.number().int().nonnegative(),
  evidenceReads: z.number().int().nonnegative(),
  evidenceBytes: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  traceEvents: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export const investigationFindingSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(opaqueIdSchema).min(1).max(32),
});
export const investigationReportSchema = z
  .strictObject({
    id: opaqueIdSchema,
    scope: investigationScopeSchema,
    status: z.enum(["complete", "partial", "error", "cancelled"]),
    reason: z.enum([
      "completed",
      "budget_exhausted",
      "model_unavailable",
      "evidence_unavailable",
      "invalid_model_output",
      "cancelled",
      "lease_lost",
    ]),
    destination: modelDestinationSchema.nullable(),
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema,
    summary: z.string().max(8000),
    findings: z.array(investigationFindingSchema).max(20),
    evidence: z.array(evidenceReferenceSchema).max(128),
    unavailable: z.array(unavailableEvidenceSchema).max(32),
    usage: investigationUsageSchema,
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt))
      ctx.addIssue({ code: "custom", message: "Report ends before it starts" });
    const allowed = {
      complete: ["completed"],
      partial: [
        "budget_exhausted",
        "model_unavailable",
        "evidence_unavailable",
        "invalid_model_output",
      ],
      error: [
        "model_unavailable",
        "evidence_unavailable",
        "invalid_model_output",
      ],
      cancelled: ["cancelled", "lease_lost"],
    };
    if (!allowed[value.status].includes(value.reason))
      ctx.addIssue({ code: "custom", message: "Outcome and reason disagree" });
    if (value.status === "complete" && !value.destination)
      ctx.addIssue({
        code: "custom",
        message: "Completed report requires model destination",
      });
    if (
      value.status === "complete" &&
      (!value.summary.trim() || value.evidence.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed report requires a summary and evidence",
      });
    const ids = new Set(value.evidence.map((e) => e.id));
    if (ids.size !== value.evidence.length)
      ctx.addIssue({ code: "custom", message: "Duplicate evidence reference" });
    for (const finding of value.findings)
      if (finding.evidenceIds.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Unknown evidence citation" });
  });
export type InvestigationScope = z.infer<typeof investigationScopeSchema>;
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;
export type InvestigationEvidence = z.infer<typeof investigationEvidenceSchema>;
export type UnavailableEvidence = z.infer<typeof unavailableEvidenceSchema>;
export type ModelDestination = z.infer<typeof modelDestinationSchema>;
export type InvestigationLimits = z.infer<typeof investigationLimitsSchema>;
export type InvestigationUsage = z.infer<typeof investigationUsageSchema>;
export type InvestigationReport = z.infer<typeof investigationReportSchema>;
