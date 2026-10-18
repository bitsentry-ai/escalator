import {
  investigationScopeSchema,
  investigationReportSchema,
  type InvestigationEvidence,
} from "../../src/contracts/index.js";
import type {
  InvestigationClaim,
  InvestigationRunResult,
} from "../../src/investigation/ports/index.js";
export function investigationFixture(): {
  claim: InvestigationClaim;
  result: InvestigationRunResult;
} {
  const at = "2026-10-01T01:00:00.000Z";
  const scope = investigationScopeSchema.parse({
    workspaceId: "org_a",
    serviceId: "api",
    environmentId: "prod",
    incidentId: "incident_a",
  });
  const window = { from: "2026-10-01T00:00:00.000Z", to: at };
  const claim: InvestigationClaim = {
    id: "inv_a",
    scope,
    runtimeId: "worker_a",
    claimToken: "claim_a",
    leaseExpiresAt: at,
    attempt: 1,
    profileId: "profile_a",
    sources: [{ kind: "log", sourceId: "source_a", window, limit: 2 }],
    limits: {
      maxDurationMs: 1000,
      maxModelCalls: 1,
      maxEvidenceReads: 4,
      maxEvidenceBytes: 8192,
      maxOutputTokens: 128,
      maxTraceEvents: 8,
    },
  };
  const item: InvestigationEvidence = {
    scope,
    reference: {
      id: "evidence_a",
      kind: "log",
      sourceId: "source_a",
      observedAt: at,
      receivedAt: at,
    },
    collectedAt: at,
    window,
    text: "HTTP 500 observed",
    truncated: false,
  };
  const report = investigationReportSchema.parse({
    id: claim.id,
    scope,
    status: "complete",
    reason: "completed",
    destination: {
      provider: "ollama",
      model: "local",
      location: "local",
      origin: "http://127.0.0.1:11434",
    },
    startedAt: at,
    finishedAt: at,
    summary: "HTTP errors observed",
    findings: [{ text: "HTTP 500", evidenceIds: [item.reference.id] }],
    evidence: [item.reference],
    unavailable: [],
    usage: {
      modelCalls: 1,
      evidenceReads: 1,
      evidenceBytes: Buffer.byteLength(JSON.stringify([item])),
      outputTokens: 128,
      traceEvents: 4,
      elapsedMs: 100,
    },
  });
  return {
    claim: structuredClone(claim),
    result: structuredClone({ report, evidence: [item] }),
  };
}
