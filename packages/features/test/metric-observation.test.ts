import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricObservation } from "../src/ui/metrics/MetricObservation.js";
import { metricObservationSchema } from "../src/contracts/index.js";
import { escalatorResources } from "../src/locales/index.js";
test("an unavailable metric sample renders insufficient data and its old configuration, never a healthy verdict", () => {
  const observation = metricObservationSchema.parse({
    id: "observation",
    workspaceId: "workspace",
    monitorId: "metric",
    monitorVersion: 1,
    observedAt: "2026-10-03T00:00:00.000Z",
    receivedAt: "2026-10-03T00:00:01.000Z",
    reason: "provider_unavailable",
    sample: null,
    provenance: null,
    inputIds: [],
    evaluation: {
      evaluatorVersion: 1,
      state: "insufficient_data",
      reason: "missing_samples",
      sampleCount: 0,
      requests: null,
      errors: null,
      minimumErrorRate: null,
    },
  });
  const html = renderToStaticMarkup(
    createElement(MetricObservation, {
      observation,
      currentVersion: 2,
      t: (key) => key,
    }),
  );
  assert.match(html, /metrics.states.insufficient_data/);
  assert.match(html, /metrics.providerReasons.provider_unavailable/);
  assert.match(html, /metrics.differentVersion/);
  assert.doesNotMatch(html, /metrics.states.clear|metrics.states.active/);
});

test("every metric outcome and provider reason has a nonempty label in all six locales", () => {
  for (const { escalator } of Object.values(escalatorResources)) {
    const { metrics } = {
      ...escalatorResources["en-US"].escalator,
      ...escalator,
    };
    for (const reason of metricObservationSchema.shape.reason.options)
      assert.ok(metrics.providerReasons[reason].trim());
    for (const state of metricObservationSchema.shape.evaluation.shape.state
      .options)
      assert.ok(metrics.states[state].trim());
    for (const reason of metricObservationSchema.shape.evaluation.shape.reason
      .options)
      assert.ok(metrics.reasons[reason].trim());
  }
});
