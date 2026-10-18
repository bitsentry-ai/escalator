import test from "node:test";
import assert from "node:assert/strict";
import {
  evidenceQuerySchema,
  investigationReportSchema,
  investigationLimitsSchema,
  modelDestinationSchema,
  investigationEvidenceSchema,
} from "../src/contracts/index.js";
const at = "2026-10-05T00:00:00.000Z";
const scope = {
  workspaceId: "org_one",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
};
const query = {
  kind: "log",
  sourceId: "configured_logs",
  window: { from: at, to: at },
  limit: 25,
};
const reference = {
  id: "e1",
  kind: "log",
  sourceId: "configured_logs",
  observedAt: at,
  receivedAt: at,
};
const usage = {
  modelCalls: 1,
  evidenceReads: 1,
  evidenceBytes: 24,
  outputTokens: 100,
  traceEvents: 2,
  elapsedMs: 50,
};
const report = {
  id: "investigation",
  scope,
  status: "complete",
  reason: "completed",
  destination: {
    provider: "ollama",
    model: "local-model",
    location: "local",
    origin: "http://127.0.0.1:11434",
  },
  startedAt: at,
  finishedAt: at,
  summary: "Connection failures observed.",
  findings: [{ text: "The connection failed.", evidenceIds: ["e1"] }],
  evidence: [reference],
  unavailable: [],
  usage,
};
test("evidence tools accept only configured source reads and bounded windows", () => {
  assert.equal(evidenceQuerySchema.safeParse(query).success, true);
  for (const input of [
    { ...query, kind: "shell" },
    { ...query, url: "http://169.254.169.254" },
    { ...query, sql: "DELETE FROM incidents" },
    { ...query, limit: 101 },
    { ...query, limit: 0 },
    { ...query, window: { from: at, to: "2026-10-07T00:00:00.000Z" } },
    { ...query, window: { from: "2026-10-06T00:00:00.000Z", to: at } },
  ])
    assert.equal(evidenceQuerySchema.safeParse(input).success, false);
});
test("evidence stays scoped and bounded, with explicit truncation", () => {
  const evidence = {
    scope,
    reference,
    collectedAt: at,
    window: query.window,
    text: "bounded output",
    truncated: true,
  };
  assert.equal(investigationEvidenceSchema.safeParse(evidence).success, true);
  for (const input of [
    { ...evidence, text: "x".repeat(16385) },
    { ...evidence, truncated: undefined },
    { ...evidence, scope: { ...scope, workspaceId: "" } },
  ])
    assert.equal(investigationEvidenceSchema.safeParse(input).success, false);
});
test("reports reject missing and duplicate citations rather than invent provenance", () => {
  assert.equal(investigationReportSchema.safeParse(report).success, true);
  assert.equal(
    investigationReportSchema.safeParse({ ...report, evidence: [] }).success,
    false,
  );
  assert.equal(
    investigationReportSchema.safeParse({
      ...report,
      evidence: [reference, reference],
    }).success,
    false,
  );
  assert.equal(
    investigationReportSchema.safeParse({
      ...report,
      findings: [{ text: "Unsupported", evidenceIds: [] }],
    }).success,
    false,
  );
});
test("partial outcomes cannot masquerade as completed reports", () => {
  assert.equal(
    investigationReportSchema.safeParse({
      ...report,
      status: "partial",
      reason: "budget_exhausted",
    }).success,
    true,
  );
  for (const input of [
    { ...report, reason: "model_unavailable" },
    { ...report, status: "partial" },
    { ...report, status: "error", reason: "cancelled" },
    { ...report, destination: null },
    { ...report, summary: " " },
    { ...report, evidence: [], findings: [] },
    { ...report, finishedAt: "2026-10-04T23:59:59.000Z" },
    {
      ...report,
      findings: Array.from({ length: 21 }, () => report.findings[0]),
    },
  ])
    assert.equal(investigationReportSchema.safeParse(input).success, false);
});
test("model display metadata rejects embedded credentials and non-HTTP origins", () => {
  for (const origin of [
    "not-a-url",
    "https://key:secret@example.com",
    "https://example.com?api_key=secret",
    "https://example.com/#secret",
    "file:///etc/passwd",
    "https://example.com/api/generate",
  ])
    assert.equal(
      modelDestinationSchema.safeParse({ ...report.destination, origin })
        .success,
      false,
    );
  assert.equal(
    modelDestinationSchema.safeParse(report.destination).success,
    true,
  );
});
test("budget limits have finite hard ceilings and cannot disable bound checks", () => {
  const limits = {
    maxDurationMs: 60000,
    maxModelCalls: 3,
    maxEvidenceReads: 8,
    maxEvidenceBytes: 65536,
    maxOutputTokens: 2048,
    maxTraceEvents: 32,
  };
  assert.equal(investigationLimitsSchema.safeParse(limits).success, true);
  for (const [key, value] of Object.entries({
    maxDurationMs: 600001,
    maxModelCalls: 11,
    maxEvidenceReads: 33,
    maxEvidenceBytes: 262145,
    maxOutputTokens: 16385,
    maxTraceEvents: 129,
  }))
    assert.equal(
      investigationLimitsSchema.safeParse({ ...limits, [key]: value }).success,
      false,
    );
  assert.equal(
    investigationLimitsSchema.safeParse({ ...limits, maxDurationMs: Infinity })
      .success,
    false,
  );
});
