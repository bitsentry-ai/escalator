import test from "node:test";
import assert from "node:assert/strict";
import {
  probeSchema,
  probeResultSchema,
  httpProbeConfigSchema,
  type Probe,
  type ProbeState,
} from "../src/contracts/probes.js";
import { observeProbe } from "../src/domain/probes/observe.js";
import {
  boundedProbeJson,
  evaluateProbeResponse,
  probeJsonValue,
  validateSyntheticProbe,
} from "../src/domain/probes/assertions.js";
const config = httpProbeConfigSchema.parse({
  url: "https://example.test/health",
  method: "GET",
  body: null,
  authSecretId: null,
  timeoutMs: 5000,
  maxResponseBytes: 65536,
  assertions: { status: [200], contains: null, json: [] },
  syntheticWrite: null,
});
function fixture(overrides: Partial<Probe> = {}) {
  const probe = probeSchema.parse({
    id: "probe",
    workspaceId: "local",
    sourceId: "source",
    serviceId: "api",
    environmentId: "prod",
    name: "API",
    version: 1,
    enabled: true,
    intervalSeconds: 60,
    critical: false,
    failureThreshold: 2,
    recoveryThreshold: 2,
    config,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  });
  let state: ProbeState | undefined;
  let count = 0;
  const observe = (outcome: "healthy" | "failed" | "unknown") => {
    count++;
    const result = probeResultSchema.parse({
      id: `result-${count}`,
      workspaceId: probe.workspaceId,
      probeId: probe.id,
      probeVersion: probe.version,
      observedAt: new Date(
        Date.parse(probe.createdAt) + count * 1000,
      ).toISOString(),
      outcome,
      reason: {
        healthy: "assertions_passed",
        failed: "network_error",
        unknown: "cancelled",
      }[outcome],
      statusCode: outcome === "healthy" ? 200 : null,
      durationMs: 10,
    });
    const decision = observeProbe(probe, state, result);
    if ("state" in decision) state = decision.state;
    return { decision, result };
  };
  return { probe, observe, state: () => state };
}
test("failure and recovery require their configured consecutive observations", () => {
  const f = fixture();
  assert.equal(
    (f.observe("failed").decision as { signal: unknown }).signal,
    null,
  );
  assert.equal(f.state()?.active, false);
  assert.equal(
    (f.observe("failed").decision as { signal: unknown }).signal,
    "active",
  );
  assert.equal(f.state()?.active, true);
  assert.equal(
    (f.observe("healthy").decision as { signal: unknown }).signal,
    null,
  );
  assert.equal(f.state()?.active, true);
  assert.equal(
    (f.observe("healthy").decision as { signal: unknown }).signal,
    "recovered",
  );
  assert.equal(f.state()?.active, false);
});
test("critical routes fail on the first observation and reject a delayed failure threshold", () => {
  const f = fixture({ critical: true, failureThreshold: 1 });
  assert.equal(
    (f.observe("failed").decision as { signal: unknown }).signal,
    "active",
  );
  assert.equal(
    probeSchema.safeParse({ ...f.probe, failureThreshold: 2 }).success,
    false,
  );
});
test("unknown telemetry breaks consecutive counters without recovering an active failure", () => {
  const f = fixture();
  f.observe("failed");
  f.observe("unknown");
  f.observe("failed");
  assert.equal(f.state()?.active, false);
  f.observe("failed");
  f.observe("healthy");
  f.observe("unknown");
  f.observe("healthy");
  assert.equal(f.state()?.active, true);
  f.observe("healthy");
  assert.equal(f.state()?.active, false);
});
test("config edits restart counters, keep active state and reject prior-version results", () => {
  const f = fixture();
  f.observe("failed");
  const { result } = f.observe("failed");
  const probe = { ...f.probe, version: 2 };
  assert.deepEqual(observeProbe(probe, f.state(), result), { ignored: true });
  const next = observeProbe(probe, f.state(), {
    ...result,
    id: "new",
    probeVersion: 2,
    observedAt: "2026-10-03T00:00:03.000Z",
    outcome: "healthy",
    reason: "assertions_passed",
    statusCode: 200,
  });
  assert.ok("state" in next);
  assert.equal(next.state.active, true);
  assert.equal(next.state.consecutiveSuccesses, 1);
});
test("replayed, stale, disabled and foreign observations cannot alter counters", () => {
  const f = fixture();
  const { result } = f.observe("failed");
  const state = structuredClone(f.state());
  assert.deepEqual(observeProbe(f.probe, f.state(), result), { ignored: true });
  assert.deepEqual(
    observeProbe(f.probe, f.state(), {
      ...result,
      id: "old",
      observedAt: f.probe.createdAt,
    }),
    { ignored: true },
  );
  assert.deepEqual(
    observeProbe({ ...f.probe, enabled: false }, undefined, result),
    { ignored: true },
  );
  assert.throws(() =>
    observeProbe(f.probe, undefined, { ...result, probeId: "foreign" }),
  );
  assert.deepEqual(f.state(), state);
});
test("HTTP status, literal body and restricted typed JSON assertions are conjunctive", () => {
  const value = {
    ...config,
    assertions: {
      status: [200],
      contains: "ready",
      json: [
        { path: ["ready"], operator: "equals" as const, value: true },
        { path: ["count"], operator: "gte" as const, value: 2 },
      ],
    },
  };
  assert.deepEqual(
    evaluateProbeResponse(value, 200, '{"ready":true,"count":3}'),
    { outcome: "healthy", reason: "assertions_passed" },
  );
  assert.equal(
    evaluateProbeResponse(value, 500, '{"ready":true,"count":3}').reason,
    "status_mismatch",
  );
  assert.equal(evaluateProbeResponse(value, 200, "{}").reason, "body_mismatch");
  assert.equal(
    evaluateProbeResponse(value, 200, '{"ready":true,"count":"3"}').reason,
    "json_mismatch",
  );
  assert.equal(
    evaluateProbeResponse(value, 200, "ready: broken JSON").reason,
    "invalid_json",
  );
});
test("JSON lookup never traverses prototypes or coerces object and array path segments", () => {
  assert.equal(probeJsonValue({}, ["constructor"]), undefined);
  assert.equal(
    probeJsonValue({ rows: [{ ok: true }] }, ["rows", 0, "ok"]),
    true,
  );
  assert.equal(
    probeJsonValue({ rows: [{ ok: true }] }, ["rows", "0", "ok"]),
    undefined,
  );
  assert.equal(probeJsonValue({ "0": true }, [0]), undefined);
  assert.throws(() => boundedProbeJson("[".repeat(18) + "0" + "]".repeat(18)));
  assert.throws(() => boundedProbeJson(JSON.stringify(Array(10001).fill(0))));
});
test("synthetic POST requires a matching application marker, idempotency strategy and cleanup guidance", () => {
  assert.equal(
    httpProbeConfigSchema.safeParse({ ...config, method: "POST", body: "{}" })
      .success,
    false,
  );
  const write = httpProbeConfigSchema.parse({
    ...config,
    method: "POST",
    body: '{"is_test":true}',
    syntheticWrite: {
      markerPath: ["is_test"],
      markerValue: true,
      idempotencyHeader: "Idempotency-Key",
      cleanupGuidance: "Delete records marked is_test after each check",
    },
  });
  validateSyntheticProbe(write);
  assert.throws(() =>
    validateSyntheticProbe({ ...write, body: '{"is_test":false}' }),
  );
  assert.equal(
    httpProbeConfigSchema.safeParse({
      ...write,
      syntheticWrite: { ...write.syntheticWrite, cleanupGuidance: "" },
    }).success,
    false,
  );
  assert.equal(
    httpProbeConfigSchema.safeParse({ ...write, method: "GET" }).success,
    false,
  );
});
test("probe configuration rejects body assertions on HEAD, unsafe URLs and non-storable text", () => {
  assert.equal(
    httpProbeConfigSchema.safeParse({
      ...config,
      method: "HEAD",
      assertions: { ...config.assertions, contains: "body" },
    }).success,
    false,
  );
  for (const url of [
    "not-a-url",
    "file:///etc/passwd",
    "https://user:secret@example.test",
    "https://example.test/#fragment",
  ])
    assert.equal(
      httpProbeConfigSchema.safeParse({ ...config, url }).success,
      false,
    );
  assert.equal(
    probeSchema.safeParse({ ...fixture().probe, name: "bad\u0000name" })
      .success,
    false,
  );
});

test("probes emit only active-state transitions across repeated observations", () => {
  const f = fixture();
  const signals = [
    "healthy",
    "healthy",
    "healthy",
    "failed",
    "failed",
    "failed",
    "unknown",
    "failed",
    "failed",
    "healthy",
    "healthy",
    "healthy",
  ].map(
    (outcome) =>
      (
        f.observe(outcome as "healthy" | "failed" | "unknown").decision as {
          signal: unknown;
        }
      ).signal,
  );
  assert.deepEqual(signals, [
    null,
    null,
    null,
    null,
    "active",
    null,
    null,
    null,
    null,
    null,
    "recovered",
    null,
  ]);
});
