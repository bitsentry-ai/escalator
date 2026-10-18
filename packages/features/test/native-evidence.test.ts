import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNativeEvidence,
  nativeEvidenceRowSchema,
} from "../src/investigation/evidence/native.js";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
} from "../src/contracts/index.js";
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
});
const at = "2026-10-01T01:00:00.000Z",
  received = "2026-10-01T01:00:01.000Z",
  collected = "2026-10-01T01:05:00.000Z";
const query = (kind = "probe", limit = 5) =>
  evidenceQuerySchema.parse({
    kind,
    sourceId: "source",
    window: { from: "2026-10-01T00:00:00.000Z", to: at },
    limit,
  });
const probe = () =>
  nativeEvidenceRowSchema.parse({
    kind: "probe",
    serviceId: "api",
    environmentId: "prod",
    receivedAt: received,
    record: {
      id: "observation",
      workspaceId: "org_a",
      probeId: "source",
      probeVersion: 1,
      observedAt: at,
      outcome: "healthy",
      reason: "assertions_passed",
      statusCode: 200,
      durationMs: 12,
    },
  });
const alert = () =>
  nativeEvidenceRowSchema.parse({
    kind: "alert",
    record: {
      id: "observation",
      workspaceId: "org_a",
      serviceId: "api",
      environmentId: "prod",
      sourceId: "source",
      version: 1,
      eventId: "provider-event",
      fingerprint: "group",
      observedAt: at,
      receivedAt: received,
      status: "active",
      severity: "critical",
      title: "HTTP errors",
      evidence: {
        summary: "authorization: Bearer private-value",
        attributes: [{ name: "token", value: "never-copy-this" }],
      },
    },
  });
const deploy = (event: "start" | "finish" = "start") =>
  nativeEvidenceRowSchema.parse({
    kind: "deployment",
    targetId: "source",
    event,
    record: {
      id: "deployment",
      workspaceId: "org_a",
      serviceId: "api",
      environmentId: "prod",
      source: "ci",
      externalId: "run",
      actor: "deployer",
      commit: "abc123",
      artifact: null,
      tokenId: "grant",
      mappedDeployerId: null,
      startedAt: at,
      acceptedAt: received,
      timeoutAt: "2026-10-01T01:30:00.000Z",
      updatedAt: "2026-10-01T01:03:00.000Z",
      status: "FAILED",
      revision: 2,
      timedOutAt: null,
      finish: {
        outcome: "FAILED",
        actor: "deployer",
        occurredAt: "2026-10-01T01:02:00.000Z",
        receivedAt: "2026-10-01T01:03:00.000Z",
      },
    },
  });
test("native probe facts preserve real receipt time and query scope without mutating input", () => {
  const row = probe(),
    before = structuredClone(row);
  const result = normalizeNativeEvidence(
    scope,
    query(),
    [row],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(row, before);
  assert.equal(result.items[0].reference.receivedAt, received);
  assert.deepEqual(result.items[0].scope, scope);
  assert.deepEqual(result.items[0].window, query().window);
  assert.equal(JSON.parse(result.items[0].text).statusCode, 200);
  assert.equal(result.truncated, false);
});
test("native evidence rejects foreign scope, source and out-of-window rows", () => {
  const row = probe();
  assert.equal(row.kind, "probe");
  if (row.kind !== "probe") return;
  for (const changed of [
    { ...row, serviceId: "other" },
    { ...row, environmentId: "other" },
    { ...row, record: { ...row.record, workspaceId: "other" } },
    { ...row, record: { ...row.record, probeId: "other" } },
    {
      ...row,
      record: { ...row.record, observedAt: "2026-09-30T23:59:59.000Z" },
    },
    { ...row, receivedAt: "2026-10-01T02:00:00.000Z" },
  ]) {
    const result = normalizeNativeEvidence(
      scope,
      query(),
      [changed],
      collected,
      8192,
    );
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable")
      assert.equal(result.unavailable.reason, "invalid_response");
  }
});
test("missing legacy probe receipt time is never synthesized", () => {
  const result = normalizeNativeEvidence(
    scope,
    query(),
    [{ ...probe(), receivedAt: null }],
    collected,
    8192,
  );
  assert.equal(result.status, "unavailable");
});
test("native alert projection excludes generic attributes and redacts credential-shaped prose", () => {
  const result = normalizeNativeEvidence(
    scope,
    query("alert"),
    [alert()],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.doesNotMatch(result.items[0].text, /private-value|never-copy-this/);
  assert.match(result.items[0].text, /REDACTED/);
});
test("deployment start evidence never inherits a later finish status", () => {
  const result = normalizeNativeEvidence(
    scope,
    query("deployment"),
    [deploy()],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const facts = JSON.parse(result.items[0].text);
  assert.equal(facts.event, "start");
  assert.equal(facts.commit, "abc123");
  assert.equal(facts.outcome, undefined);
  assert.doesNotMatch(result.items[0].text, /FAILED/);
  assert.equal(result.items[0].reference.observedAt, at);
});
test("deployment finish is a distinct event that must fall within the selected window", () => {
  assert.equal(
    normalizeNativeEvidence(
      scope,
      query("deployment"),
      [deploy("finish")],
      collected,
      8192,
    ).status,
    "unavailable",
  );
  const q = { ...query("deployment"), window: { from: at, to: collected } };
  const result = normalizeNativeEvidence(
    scope,
    q,
    [deploy("finish")],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(
    result.items[0].reference.observedAt,
    "2026-10-01T01:02:00.000Z",
  );
  assert.equal(JSON.parse(result.items[0].text).outcome, "FAILED");
});
test("native evidence reports row truncation and incomplete retained history", () => {
  const first = probe(),
    second = probe();
  second.record.id = "second";
  for (const result of [
    normalizeNativeEvidence(
      scope,
      query("probe", 1),
      [first, second],
      collected,
      8192,
    ),
    normalizeNativeEvidence(scope, query(), [first], collected, 8192, true),
  ]) {
    assert.equal(result.status, "available");
    if (result.status === "available") assert.equal(result.truncated, true);
  }
});
test("native evidence byte limits include serialized scope and provenance", () => {
  const full = normalizeNativeEvidence(
    scope,
    query(),
    [probe()],
    collected,
    8192,
  );
  assert.equal(full.status, "available");
  if (full.status !== "available") return;
  const bytes = Buffer.byteLength(JSON.stringify(full.items), "utf8");
  assert.equal(
    normalizeNativeEvidence(scope, query(), [probe()], collected, bytes).status,
    "available",
  );
  const short = normalizeNativeEvidence(
    scope,
    query(),
    [probe()],
    collected,
    bytes - 1,
  );
  assert.equal(short.status, "unavailable");
  if (short.status === "unavailable")
    assert.equal(short.unavailable.reason, "budget_exhausted");
});
test("empty and unsupported native evidence stay unavailable", () => {
  for (const q of [query(), query("log"), query("git_diff")])
    assert.equal(
      normalizeNativeEvidence(scope, q, [], collected, 8192).status,
      "unavailable",
    );
});
test("duplicate and excessive native rows fail closed", () => {
  const row = probe();
  assert.equal(
    normalizeNativeEvidence(scope, query(), [row, row], collected, 8192).status,
    "unavailable",
  );
  assert.equal(
    normalizeNativeEvidence(
      scope,
      query("probe", 1),
      [row, row, row],
      collected,
      8192,
    ).status,
    "unavailable",
  );
});
test("different evidence kinds cannot collide on the same provider observation ID", () => {
  const a = normalizeNativeEvidence(scope, query(), [probe()], collected, 8192),
    b = normalizeNativeEvidence(
      scope,
      query("alert"),
      [alert()],
      collected,
      8192,
    );
  assert.equal(a.status, "available");
  assert.equal(b.status, "available");
  if (a.status === "available" && b.status === "available")
    assert.notEqual(a.items[0].reference.id, b.items[0].reference.id);
});

test("stored metric evaluations remain explicit, including unusable samples", () => {
  const row = nativeEvidenceRowSchema.parse({
    kind: "metric",
    serviceId: "api",
    environmentId: "prod",
    record: {
      id: "metric-observation",
      workspaceId: "org_a",
      monitorId: "source",
      monitorVersion: 2,
      observedAt: at,
      receivedAt: received,
      reason: "provider_unavailable",
      sample: null,
      provenance: null,
      evaluation: {
        evaluatorVersion: 1,
        state: "insufficient_data",
        reason: "missing_samples",
        sampleCount: 0,
        requests: null,
        errors: null,
        minimumErrorRate: null,
      },
      inputIds: [],
    },
  });
  const result = normalizeNativeEvidence(
    scope,
    query("metric"),
    [row],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(
    JSON.parse(result.items[0].text).evaluation.state,
    "insufficient_data",
  );
  assert.equal(JSON.parse(result.items[0].text).sample, null);
  assert.equal(result.items[0].reference.receivedAt, received);
});
test("deployment timeout is a persisted decision event, not its scheduled deadline", () => {
  const row = deploy();
  assert.equal(row.kind, "deployment");
  if (row.kind !== "deployment") return;
  const timeout = {
    ...row,
    event: "timeout",
    record: {
      ...row.record,
      status: "TIMED_OUT",
      finish: null,
      timedOutAt: at,
      startedAt: "2026-10-01T00:00:00.000Z",
      acceptedAt: "2026-10-01T00:00:01.000Z",
      timeoutAt: "2026-10-01T00:30:00.000Z",
    },
  };
  const result = normalizeNativeEvidence(
    scope,
    query("deployment"),
    [timeout],
    collected,
    8192,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.items[0].reference.observedAt, at);
  assert.equal(JSON.parse(result.items[0].text).event, "timeout");
  assert.equal(
    normalizeNativeEvidence(
      scope,
      query("deployment"),
      [{ ...timeout, record: { ...timeout.record, timedOutAt: null } }],
      collected,
      8192,
    ).status,
    "unavailable",
  );
});
