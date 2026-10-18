import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import type {
  WatchEvidenceWindow,
  WatchStreamEvidence,
} from "../src/contracts/deploy-watch.js";
import {
  evaluateWatchStream,
  probeWatchCriteria,
  metricWatchCriteria,
} from "../src/application/deploy/watch.js";
const scope = workspaceIdSchema.parse("watch-workspace");
const at = (seconds: number) =>
  new Date(
    Date.parse("2026-10-04T00:00:00.000Z") + seconds * 1000,
  ).toISOString();
function window(
  kind: "probe" | "metric",
  from: number,
  to: number,
  visible: number,
): WatchEvidenceWindow {
  return {
    workspaceId: scope,
    streamId: "api",
    startAt: at(from),
    endAt: at(to),
    visibleAt: at(visible),
    complete: true,
    configurationCompatible: true,
    segments: [
      {
        version: 1,
        startAt: at(from),
        endAt: at(to),
        recordedAt: at(-1000),
        enabled: true,
        anchorAt: at(0),
        stepSeconds: 60,
      },
    ],
    samples: Array.from({ length: (to - from) / 60 }, (_, index) => {
      const point = from + index * 60;
      return {
        id: `sample-${point}`,
        version: 1,
        slotAt: at(point),
        observedAt: at(point + 1),
        receivedAt: at(point + 2),
        usable: true,
        reading:
          kind === "probe"
            ? { kind: "probe" as const, state: "healthy" as const }
            : {
                kind: "metric" as const,
                quality: "complete" as const,
                requests: 100,
                errors: 0,
              },
      };
    }),
  };
}
function fixture(kind: "probe" | "metric" = "probe"): WatchStreamEvidence {
  return {
    deploymentStartedAt: at(0),
    watchEndsAt: at(2100),
    evaluatedAt: at(2220),
    criteria:
      kind === "probe"
        ? probeWatchCriteria({ critical: false, failureThreshold: 3 })
        : metricWatchCriteria({
            rule: {
              windowSeconds: 300,
              minimumSamples: 3,
              minimumRequests: 100,
              errorRateFloor: 0.01,
            },
          }),
    baseline: window(kind, -900, 0, 0),
    watch: window(kind, 300, 2100, 2220),
  };
}
const evaluate = (input: WatchStreamEvidence) =>
  evaluateWatchStream(scope, input);
function probeFailure(input: WatchStreamEvidence, index: number) {
  input.watch.samples[index].reading = { kind: "probe", state: "failed" };
}
function metricCounts(
  input: WatchStreamEvidence,
  baselineErrors: number,
  watchErrors: number,
  requests = 100,
) {
  for (const row of input.baseline.samples)
    row.reading = {
      kind: "metric",
      quality: "complete",
      requests,
      errors: baselineErrors,
    };
  for (const row of input.watch.samples)
    row.reading = {
      kind: "metric",
      quality: "complete",
      requests,
      errors: watchErrors,
    };
}
test("a complete healthy watch passes only after the receipt grace expires", () => {
  const input = fixture();
  const result = evaluate(input);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.final, true);
  assert.equal(result.baseline.coverage.availableSlots, 15);
  assert.equal(result.watch.coverage.availableSlots, 30);
  assert.equal(result.watch.evidence.length, 30);
  input.evaluatedAt = input.watch.visibleAt = at(2219);
  assert.equal(evaluate(input).verdict, "PENDING");
  assert.equal(evaluate(input).final, false);
});
test("healthy in-progress evidence never produces a premature pass", () => {
  const input = fixture();
  input.evaluatedAt = at(480);
  input.watch = window("probe", 300, 480, 480);
  assert.equal(evaluate(input).verdict, "PENDING");
});
test("missing baseline, missing observations and truncated queries are insufficient", () => {
  for (const target of ["baseline", "watch"] as const) {
    const input = fixture();
    input[target].samples.pop();
    assert.equal(evaluate(input).verdict, "INSUFFICIENT_DATA");
    input[target].complete = false;
    assert.equal(evaluate(input).verdict, "INSUFFICIENT_DATA");
  }
});
test("incompatible measurement changes cannot be declared healthy", () => {
  for (const target of ["baseline", "watch"] as const) {
    const input = fixture();
    input[target].configurationCompatible = false;
    assert.equal(evaluate(input).reason, "configuration_changed");
  }
});
test("unknown or disabled historical configuration cannot pass", () => {
  for (const recordedAt of [null, at(2221)]) {
    const input = fixture();
    input.watch.segments[0].recordedAt = recordedAt;
    assert.equal(evaluate(input).verdict, "INSUFFICIENT_DATA");
  }
  const disabled = fixture();
  disabled.watch.segments[0].enabled = false;
  assert.equal(evaluate(disabled).verdict, "INSUFFICIENT_DATA");
});
test("consecutive failures meet the captured probe threshold", () => {
  const input = fixture();
  for (const index of [3, 4, 5]) probeFailure(input, index);
  const result = evaluate(input);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.longestFailureRun, 3);
  assert.equal(result.watch.failedProbes, 3);
  assert.equal(result.criteria.kind, "probe");
});
test("a qualifying failure streak fails despite an unrelated watch gap", () => {
  const input = fixture();
  for (const index of [3, 4, 5]) probeFailure(input, index);
  input.watch.samples.splice(20, 1);
  const result = evaluate(input);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.reason, "threshold_met");
  assert.equal(result.watch.coverage.gaps.length, 1);
  input.watch.complete = false;
  assert.equal(evaluate(input).reason, "watch_coverage");
});
test("a gap without a qualifying streak stays insufficient", () => {
  const healthy = fixture();
  healthy.watch.samples.splice(20, 1);
  assert.equal(evaluate(healthy).verdict, "INSUFFICIENT_DATA");
  assert.equal(evaluate(healthy).reason, "watch_coverage");
  const interrupted = fixture();
  for (const index of [3, 4, 6]) probeFailure(interrupted, index);
  interrupted.watch.samples.splice(5, 1);
  const result = evaluate(interrupted);
  assert.equal(result.verdict, "INSUFFICIENT_DATA");
  assert.equal(result.longestFailureRun, 2);
});
test("isolated failures do not invent a consecutive streak", () => {
  const input = fixture();
  for (const index of [1, 3, 5]) probeFailure(input, index);
  const result = evaluate(input);
  assert.equal(result.verdict, "WARN");
  assert.equal(result.longestFailureRun, 1);
});
test("a compatible cadence change preserves consecutive scheduled observations", () => {
  const input = fixture();
  input.watch.segments = [
    {
      ...input.watch.segments[0],
      version: 2,
      recordedAt: at(100),
      endAt: at(360),
      anchorAt: at(300),
      stepSeconds: 120,
    },
    {
      ...input.watch.segments[0],
      version: 3,
      startAt: at(360),
      anchorAt: at(360),
      recordedAt: at(360),
    },
  ];
  input.watch.samples[0].version = 2;
  for (const row of input.watch.samples.slice(1)) row.version = 3;
  for (const index of [0, 1, 2]) probeFailure(input, index);
  const result = evaluate(input);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.longestFailureRun, 3);
});
test("a critical probe can fail an active watch on its first covered sample", () => {
  const input = fixture();
  input.criteria = probeWatchCriteria({ critical: true, failureThreshold: 1 });
  input.evaluatedAt = at(360);
  input.watch = window("probe", 300, 360, 360);
  probeFailure(input, 0);
  const result = evaluate(input);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.final, false);
});
test("late observations, receipts and unknown outcomes remain coverage gaps", () => {
  for (const change of [
    "observation",
    "receipt",
    "unknown",
    "reversed-time",
  ] as const) {
    const input = fixture();
    const row = input.watch.samples[0];
    if (change === "observation") row.observedAt = row.receivedAt = at(360);
    else if (change === "receipt") row.receivedAt = at(2221);
    else if (change === "reversed-time") row.receivedAt = at(300);
    else row.reading = { kind: "probe", state: "unknown" };
    assert.equal(evaluate(input).verdict, "INSUFFICIENT_DATA");
  }
});
test("a newer unusable correction cannot be replaced with older healthy evidence", () => {
  const input = fixture();
  input.watch.samples.push({
    ...input.watch.samples[0],
    id: "correction",
    receivedAt: at(310),
    reading: { kind: "probe", state: "unknown" },
  });
  assert.equal(evaluate(input).verdict, "INSUFFICIENT_DATA");
});
test("late retries retain the original bounded evidence cutoff", () => {
  const input = fixture();
  input.watch.samples.push({
    ...input.watch.samples[0],
    id: "too-late",
    receivedAt: at(2221),
    reading: { kind: "probe", state: "failed" },
  });
  input.evaluatedAt = at(86400);
  assert.equal(evaluate(input).verdict, "PASS");
  input.watch.visibleAt = at(86400);
  assert.throws(() => evaluate(input), /chronology/);
});
test("preexisting unhealthy probe evidence stays visible", () => {
  const input = fixture();
  input.baseline.samples[0].reading = { kind: "probe", state: "failed" };
  const result = evaluate(input);
  assert.equal(result.verdict, "WARN");
  assert.equal(result.reason, "baseline_unhealthy");
  assert.equal(result.baseline.failedProbes, 1);
});
test("metrics record the stricter absolute, relative and configured threshold", () => {
  const input = fixture("metric");
  metricCounts(input, 2, 5);
  const result = evaluate(input);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.baselineErrorRate, 0.02);
  assert.equal(result.watchErrorRate, 0.05);
  assert.equal(result.effectiveErrorRateThreshold, 0.04);
  assert.equal(result.baseline.requests, 1500);
  assert.equal(result.watch.requests, 3000);
  metricCounts(input, 2, 3);
  assert.equal(evaluate(input).verdict, "WARN");
});
test("zero or inadequate traffic is never success", () => {
  for (const requests of [0, 1]) {
    const input = fixture("metric");
    metricCounts(input, 0, 0, requests);
    assert.equal(evaluate(input).reason, "insufficient_requests");
  }
});
test("known metric regression can fail before the thirty-minute watch closes", () => {
  const input = fixture("metric");
  input.evaluatedAt = at(480);
  input.watch = window("metric", 300, 480, 480);
  metricCounts(input, 0, 2);
  assert.equal(evaluate(input).verdict, "FAIL");
  assert.equal(evaluate(input).final, false);
});
test("a metric regression fails despite a watch gap only with enough usable traffic", () => {
  const input = fixture("metric");
  metricCounts(input, 0, 2);
  input.watch.samples.splice(10, 1);
  assert.equal(evaluate(input).verdict, "FAIL");
  metricCounts(input, 0, 0);
  assert.equal(evaluate(input).reason, "watch_coverage");
  const sparse = fixture("metric");
  metricCounts(sparse, 0, 2);
  sparse.watch.samples = sparse.watch.samples.slice(0, 2);
  assert.equal(evaluate(sparse).reason, "watch_coverage");
});
test("aggregate counts beyond the safe numeric range are insufficient", () => {
  const input = fixture("metric");
  metricCounts(input, 0, 0, Number.MAX_SAFE_INTEGER);
  const result = evaluate(input);
  assert.equal(result.reason, "count_overflow");
  assert.equal(result.baseline.requests, null);
  assert.equal(result.effectiveErrorRateThreshold, null);
});
test("scope, stream identity, reading kind and invalid chronology are rejected", () => {
  const mutations: ((value: WatchStreamEvidence) => void)[] = [
    (value) => {
      value.baseline.workspaceId = workspaceIdSchema.parse("other");
    },
    (value) => {
      value.watch.streamId = "other";
    },
    (value) => {
      value.watch.samples[0].reading = {
        kind: "metric",
        quality: "complete",
        requests: 1,
        errors: 0,
      };
    },
    (value) => {
      value.baseline.endAt = at(1);
    },
    (value) => {
      value.baseline.visibleAt = at(301);
    },
    (value) => {
      value.watch.endAt = at(2099);
    },
    (value) => {
      value.watch.visibleAt = at(2100);
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => evaluate(input));
  }
});
test("evaluation owns its snapshot and cannot mutate the caller's evidence", () => {
  const input = fixture("metric");
  const saved = structuredClone(input);
  const result = evaluate(input);
  assert.deepEqual(input, saved);
  result.watch.evidence[0].id = "modified";
  assert.deepEqual(input, saved);
});

test("one configuration revision cannot describe conflicting cadence or history", () => {
  for (const patch of [
    { stepSeconds: 120 },
    { anchorAt: at(60) },
    { recordedAt: at(-900) },
    { enabled: false },
  ]) {
    const input = fixture();
    Object.assign(input.watch.segments[0], patch);
    const result = evaluate(input);
    assert.equal(result.verdict, "INSUFFICIENT_DATA");
    assert.equal(result.reason, "configuration_changed");
  }
});
test("healthy metric traffic passes and the configured floor bounds regression", () => {
  const input = fixture("metric");
  assert.equal(evaluate(input).verdict, "PASS");
  assert.equal(input.criteria.kind, "metric");
  if (input.criteria.kind !== "metric")
    throw new Error("Expected metric criteria");
  input.criteria.errorRateFloor = 0.2;
  metricCounts(input, 2, 10);
  assert.equal(evaluate(input).verdict, "WARN");
  assert.equal(evaluate(input).effectiveErrorRateThreshold, 0.2);
  metricCounts(input, 2, 20);
  assert.equal(evaluate(input).verdict, "FAIL");
});
