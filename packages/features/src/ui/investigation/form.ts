import {
  createInvestigationSettingsSchema,
  updateInvestigationSettingsSchema,
  modelProfileSchema,
  type InvestigationSettings,
  type InvestigationSourceSelection,
  type ModelProfile,
} from "../../contracts/index.js";
export interface InvestigationForm {
  enabled: boolean;
  provider: ModelProfile["destination"]["provider"];
  location: ModelProfile["destination"]["location"];
  model: string;
  endpoint: string;
  secretId: string;
  durationSeconds: string;
  evidenceReads: string;
  evidenceKiB: string;
  outputTokens: string;
  sources: InvestigationSourceSelection[];
}
export function investigationForm(
  initial?: InvestigationSettings,
): InvestigationForm {
  return {
    enabled: initial?.enabled ?? false,
    provider: initial?.profile.destination.provider ?? "ollama",
    location: initial?.profile.destination.location ?? "local",
    model: initial?.profile.destination.model ?? "",
    endpoint: initial?.profile.endpoint ?? "http://127.0.0.1:11434",
    secretId: initial?.profile.secretId ?? "",
    durationSeconds: String((initial?.limits.maxDurationMs ?? 60000) / 1000),
    evidenceReads: String(initial?.limits.maxEvidenceReads ?? 8),
    evidenceKiB: String((initial?.limits.maxEvidenceBytes ?? 32768) / 1024),
    outputTokens: String(initial?.limits.maxOutputTokens ?? 1024),
    sources: initial?.sources.map((source) => ({ ...source })) ?? [],
  };
}
export function investigationInput(
  form: InvestigationForm,
  scope: { serviceId: string; environmentId: string },
  initial?: InvestigationSettings,
) {
  // Use the shared complete profile validator before transport; never include this
  // validation-only workspace in a request. Actual scope is supplied by the host.
  const profile = modelProfileSchema.parse({
    id: initial?.profile.id ?? "validation",
    revision: initial?.profile.revision ?? 1,
    scope: { workspaceId: "validation", ...scope },
    destination: {
      provider: form.provider,
      location: form.location,
      model: form.model,
      origin: new URL(form.endpoint).origin,
    },
    endpoint: form.endpoint,
    secretId: form.secretId || null,
  });
  const options = {
    enabled: form.enabled,
    destination: profile.destination,
    endpoint: profile.endpoint,
    secretId: profile.secretId,
    limits: {
      maxDurationMs: Number(form.durationSeconds) * 1000,
      maxModelCalls: initial?.limits.maxModelCalls ?? 1,
      maxEvidenceReads: Number(form.evidenceReads),
      maxEvidenceBytes: Number(form.evidenceKiB) * 1024,
      maxOutputTokens: Number(form.outputTokens),
      maxTraceEvents: initial?.limits.maxTraceEvents ?? 32,
    },
    sources: form.sources,
  };
  return initial
    ? {
        kind: "update" as const,
        input: updateInvestigationSettingsSchema.parse({
          id: initial.profile.id,
          expectedRevision: initial.profile.revision,
          ...options,
        }),
      }
    : {
        kind: "create" as const,
        input: createInvestigationSettingsSchema.parse({
          ...scope,
          ...options,
        }),
      };
}
