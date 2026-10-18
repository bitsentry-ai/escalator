import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSustainedFloor } from "../src/domain/rules/sustained-floor.js";
import type { MetricsObservation } from "../src/contracts/metrics.js";
const rule = {
  windowSeconds: 180,
  minimumSamples: 3,
  minimumRequests: 100,
  errorRateFloor: 0.05,
};
function window(rates = [0.05, 0.1, 0.2]): MetricsObservation {
  const start = Date.parse("2026-10-03T00:01:00.000Z");
  return {
    samples: rates.map((rate, i) => ({
      observedAt: new Date(start + i * 60000).toISOString(),
      requests: 100,
      errors: 100 * rate,
      quality: "complete",
    })),
    provenance: {
      provider: "prometheus",
      datasourceUid: null,
      requestsQueryHash: "a".repeat(64),
      errorsQueryHash: "b".repeat(64),
      requestsSeriesHash: null,
      errorsSeriesHash: null,
      range: {
        startAt: new Date(start).toISOString(),
        endAt: new Date(start + 120000).toISOString(),
        stepSeconds: 60,
      },
    },
  };
}
test("sustained floor compares the lowest interval rate and preserves a deterministic versioned verdict", () => {
  const observation = window();
  const verdict = evaluateSustainedFloor(rule, observation);
  assert.deepEqual(verdict, {
    evaluatorVersion: 1,
    state: "active",
    reason: "floor_met",
    sampleCount: 3,
    requests: 300,
    errors: 35,
    minimumErrorRate: 0.05,
  });
  assert.deepEqual(
    evaluateSustainedFloor(rule, structuredClone(observation)),
    verdict,
  );
  assert.equal(
    evaluateSustainedFloor(rule, window([0.1, 0.04, 0.2])).state,
    "clear",
  );
  assert.equal(evaluateSustainedFloor(rule, window([0, 0, 0])).state, "clear");
});
test("missing, duplicate, out-of-order and annotated samples never yield clear", () => {
  const cases: MetricsObservation[] = [];
  let value = window();
  value.samples.splice(1, 1);
  cases.push(value);
  value = window();
  value.samples[1].observedAt = value.samples[0].observedAt;
  cases.push(value);
  value = window();
  value.samples.reverse();
  cases.push(value);
  value = window();
  value.samples[0].observedAt = "2026-10-03 00:01:00";
  cases.push(value);
  for (const quality of [
    "missing",
    "nonfinite",
    "provider_annotation",
    "invalid_counts",
  ] as const) {
    value = window([0, 0, 0]);
    value.samples[1].quality = quality;
    cases.push(value);
  }
  for (const observation of cases)
    assert.equal(
      evaluateSustainedFloor(rule, observation).state,
      "insufficient_data",
    );
});
test("zero traffic, insufficient counts, impossible values and short windows stay unknown", () => {
  const cases: MetricsObservation[] = [];
  let value = window();
  value.samples[0].requests = 0;
  value.samples[0].errors = 0;
  cases.push(value);
  value = window();
  value.samples.forEach((s) => {
    s.requests = 1;
    s.errors = 0;
  });
  cases.push(value);
  for (const count of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    value = window();
    value.samples[1].requests = count;
    cases.push(value);
  }
  value = window();
  value.samples[1].errors = 101;
  cases.push(value);
  value = window();
  value.provenance.range.endAt = value.provenance.range.startAt;
  cases.push(value);
  for (const observation of cases)
    assert.equal(
      evaluateSustainedFloor(rule, observation).state,
      "insufficient_data",
    );
  assert.equal(
    evaluateSustainedFloor({ ...rule, minimumSamples: 4 }, window()).state,
    "insufficient_data",
  );
});
