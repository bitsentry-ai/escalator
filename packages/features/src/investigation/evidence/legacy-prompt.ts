import { asRecord, truncateLegacyEvidenceText } from "./legacy-values.js";
import {
  getWazuhHttpFacts,
  HTTP_EVIDENCE_GUIDANCE,
} from "./wazuh-http-facts.js";
import type {
  LegacyDiagnosisEvidenceRequest,
  LegacyDiagnosisEvidenceCollection,
} from "./legacy-types.js";
const EVIDENCE_PROMPT_CHAR_BUDGET = 10_000;
// Compatibility compaction preserves the existing diagnosis prompt. It is not a secret redactor.
const COMPACT_BLACKLISTED_KEYS = new Set([
  "stacktrace",
  "stack_trace",
  "frames",
  "breadcrumbs",
  "requestHeaders",
  "request_headers",
  "responseHeaders",
  "response_headers",
  "headers",
  "cookies",
  "requestBody",
  "request_body",
  "responseBody",
  "response_body",
]);

function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateLegacyEvidenceText(value, 500);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `[array:${String(value.length)}]`;
    }

    return value.slice(0, 5).map((item) => compactValue(item, depth + 1));
  }

  const record = asRecord(value);
  if (record === undefined) {
    return "[non-json-value]";
  }

  if (depth >= 3) {
    return "[object]";
  }

  const entries = Object.entries(record)
    .filter(([key]) => !COMPACT_BLACKLISTED_KEYS.has(key))
    .slice(0, 24)
    .map(([key, item]) => [key, compactValue(item, depth + 1)] as const);

  return Object.fromEntries(entries);
}

function stringifyPromptJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function buildEvidenceBundle(input: {
  request: LegacyDiagnosisEvidenceRequest;
  evidence: LegacyDiagnosisEvidenceCollection;
}): Record<string, unknown> {
  return {
    verificationMethod: "source_evidence",
    source: {
      type: input.evidence.sourceType,
      id: input.evidence.sourceId,
      name: input.evidence.sourceName,
    },
    originalEntry: {
      httpFacts: getWazuhHttpFacts(input.evidence.providerObject),
      entryId: input.request.entryId,
      entryIndex: input.request.entryIndex,
      ruleId: input.request.ruleId,
      ruleDescription: input.request.ruleDescription,
      ruleLevel: input.request.ruleLevel,
      ruleGroups: input.request.ruleGroups,
      category: input.request.category,
      timestamp: input.request.entryTimestamp.toISOString(),
      agentName: input.request.agentName,
      agentIp: input.request.agentIp,
    },
    originalProviderObject: compactValue(input.evidence.providerObject),
    evidenceQueries: input.evidence.queries,
  };
}

export function buildLegacyEvidenceVerificationPrompt(input: {
  request: LegacyDiagnosisEvidenceRequest;
  evidence: LegacyDiagnosisEvidenceCollection;
}): string {
  const bundleText = stringifyPromptJson(
    buildEvidenceBundle({
      request: input.request,
      evidence: input.evidence,
    }),
  );
  const diagnosisText = truncateLegacyEvidenceText(
    input.request.diagnosisText,
    1_200,
  );
  const truncatedBundle = truncateLegacyEvidenceText(
    bundleText,
    EVIDENCE_PROMPT_CHAR_BUDGET,
  );

  return [
    "You are a cybersecurity verification agent using source evidence only.",
    "Verify a previous AI diagnosis of a security telemetry entry.",
    "Use only the original telemetry and follow-up source query evidence in this prompt.",
    HTTP_EVIDENCE_GUIDANCE,
    "Do not claim live server inspection, MCP tool use, OS inspection, registry checks, SSH access, or direct host access.",
    "If the evidence is only the original telemetry and no independent support exists, choose PARTIALLY_VERIFIED or NOT_VERIFIED.",
    "When event-level source evidence confirms the issue's core facts and does not contradict the diagnosis, choose PARTIALLY_VERIFIED instead of NOT_VERIFIED; never infer facts that the evidence does not show.",
    "If source evidence contradicts the diagnosis, choose NOT_VERIFIED.",
    "Never omit the VERDICT line.",
    "",
    "Return exactly these sections:",
    "SUMMARY: <1-3 short sentences>",
    "EVIDENCE: <short sentence or semicolon-separated list citing source evidence>",
    "VERDICT: <VERIFIED|PARTIALLY_VERIFIED|NOT_VERIFIED>",
    "The final line must be the VERDICT line.",
    "",
    "PREVIOUS AI DIAGNOSIS:",
    diagnosisText,
    "",
    "SOURCE EVIDENCE BUNDLE:",
    truncatedBundle,
  ].join("\n");
}
