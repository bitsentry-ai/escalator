import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationClaimSchema,
  validateInvestigationResult,
  InvalidInvestigationResult,
} from "../src/investigation/orchestration/claims.js";
import { investigationFixture } from "./fixtures/investigation.js";
import type { InvestigationRunResult } from "../src/investigation/ports/index.js";
test("claim parsing captures a strict detached configuration without authenticating its lease", () => {
  const { claim } = investigationFixture();
  const copy = investigationClaimSchema.parse(claim);
  assert.deepEqual(copy, claim);
  claim.limits.maxModelCalls = 2;
  assert.equal(copy.limits.maxModelCalls, 1);
  assert.equal(
    investigationClaimSchema.safeParse({ ...copy, administrator: true })
      .success,
    false,
  );
  assert.equal(
    investigationClaimSchema.safeParse({ ...copy, claimToken: "" }).success,
    false,
  );
  assert.equal(
    investigationClaimSchema.safeParse({ ...copy, attempt: 0 }).success,
    false,
  );
});
test("result validation retains redacted snapshots without sharing mutable caller objects", () => {
  const { claim, result } = investigationFixture();
  const copy = validateInvestigationResult(claim, result);
  assert.deepEqual(copy, result);
  result.evidence[0].text = "changed";
  assert.notEqual(copy.evidence[0].text, result.evidence[0].text);
});
test("results cannot change any claim scope axis or investigation ID", () => {
  for (const axis of [
    "workspaceId",
    "serviceId",
    "environmentId",
    "incidentId",
  ]) {
    const { claim, result } = investigationFixture();
    Object.assign(result.report.scope, { [axis]: "foreign" });
    assert.throws(
      () => validateInvestigationResult(claim, result),
      InvalidInvestigationResult,
    );
  }
  const { claim, result } = investigationFixture();
  result.report.id = "other";
  assert.throws(
    () => validateInvestigationResult(claim, result),
    InvalidInvestigationResult,
  );
});
test("snapshot scope and the exact reference list must match the scoped report", () => {
  const mutations: Array<(r: InvestigationRunResult) => void> = [
    (r) => {
      r.evidence = [];
    },
    (r) => {
      r.evidence.push(structuredClone(r.evidence[0]));
    },
    (r) => {
      r.evidence[0].scope = { ...r.evidence[0].scope, incidentId: "other" };
    },
    (r) => {
      r.evidence[0].reference = { ...r.evidence[0].reference, id: "unlisted" };
    },
    (r) => {
      r.evidence[0].reference = {
        ...r.evidence[0].reference,
        receivedAt: "2026-10-01T00:01:00.000Z",
      };
    },
    (r) => {
      r.evidence[0].text = "  ";
    },
  ];
  for (const mutate of mutations) {
    const { claim, result } = investigationFixture();
    mutate(result);
    result.report.usage.evidenceBytes = result.evidence.length
      ? Buffer.byteLength(JSON.stringify(result.evidence), "utf8")
      : 0;
    assert.throws(
      () => validateInvestigationResult(claim, result),
      InvalidInvestigationResult,
    );
  }
});
test("only configured query kinds, sources and windows authorize evidence provenance", () => {
  for (const mutate of [
    (r: InvestigationRunResult) => {
      r.evidence[0].reference.sourceId = "other";
      r.report.evidence[0].sourceId = "other";
    },
    (r: InvestigationRunResult) => {
      r.evidence[0].reference.kind = "metric";
      r.report.evidence[0].kind = "metric";
    },
    (r: InvestigationRunResult) => {
      r.evidence[0].window.from = "2026-09-30T23:00:00.000Z";
    },
  ]) {
    const { claim, result } = investigationFixture();
    mutate(result);
    result.report.usage.evidenceBytes = result.evidence.length
      ? Buffer.byteLength(JSON.stringify(result.evidence), "utf8")
      : 0;
    assert.throws(
      () => validateInvestigationResult(claim, result),
      InvalidInvestigationResult,
    );
  }
});
test("future receipts and observations outside the captured query are rejected", () => {
  for (const field of ["receivedAt", "observedAt"] as const) {
    const { claim, result } = investigationFixture();
    result.evidence[0].reference[field] = "2026-10-01T02:00:00.000Z";
    result.report.evidence[0][field] = "2026-10-01T02:00:00.000Z";
    assert.throws(
      () => validateInvestigationResult(claim, result),
      InvalidInvestigationResult,
    );
  }
});
test("resource counters cannot exceed the captured limits or undercount snapshot bytes", () => {
  for (const field of [
    "modelCalls",
    "evidenceReads",
    "evidenceBytes",
    "outputTokens",
    "traceEvents",
  ] as const) {
    const { claim, result } = investigationFixture();
    result.report.usage[field] = Number.MAX_SAFE_INTEGER;
    assert.throws(
      () => validateInvestigationResult(claim, result),
      InvalidInvestigationResult,
    );
  }
  const { claim, result } = investigationFixture();
  result.report.usage.evidenceBytes = 1;
  assert.throws(
    () => validateInvestigationResult(claim, result),
    InvalidInvestigationResult,
  );
});
test("a complete result cannot hide missing or truncated evidence", () => {
  const { claim, result } = investigationFixture();
  result.evidence[0].truncated = true;
  assert.throws(
    () => validateInvestigationResult(claim, result),
    InvalidInvestigationResult,
  );
  const second = investigationFixture();
  second.result.report.unavailable = [
    { query: second.claim.sources[0], reason: "not_found" },
  ];
  assert.throws(
    () => validateInvestigationResult(second.claim, second.result),
    InvalidInvestigationResult,
  );
});
test("unavailable queries are still bound to the captured allowlist", () => {
  const { claim, result } = investigationFixture();
  result.report.status = "partial";
  result.report.reason = "evidence_unavailable";
  result.report.unavailable = [
    {
      query: { ...claim.sources[0], sourceId: "foreign" },
      reason: "not_found",
    },
  ];
  assert.throws(
    () => validateInvestigationResult(claim, result),
    InvalidInvestigationResult,
  );
});
test("empty cancelled outcomes and elapsed overrun remain representable", () => {
  const { claim, result } = investigationFixture();
  Object.assign(result.report, {
    status: "cancelled",
    reason: "cancelled",
    summary: "",
    findings: [],
    evidence: [],
    destination: null,
  });
  result.evidence = [];
  Object.assign(result.report.usage, {
    modelCalls: 0,
    evidenceReads: 0,
    evidenceBytes: 0,
    outputTokens: 0,
    traceEvents: 0,
    elapsedMs: 1001,
  });
  assert.deepEqual(validateInvestigationResult(claim, result), result);
});
