import test from "node:test";
import assert from "node:assert/strict";
import {
  metricsQuerySchema,
  metricsRangeSchema,
} from "../src/contracts/metrics.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { normalizeMetricCounts } from "../src/adapters/metrics/normalize.js";
import { PrometheusMetricsReader } from "../src/adapters/metrics/reader.js";
import type { ProbeRequest } from "../src/application/probes/transport.js";
const range = metricsRangeSchema.parse({
  startAt: "2026-10-03T00:00:00.000Z",
  endAt: "2026-10-03T00:02:00.000Z",
  stepSeconds: 60,
});
const start = Date.parse(range.startAt) / 1000;
const config = metricsQuerySchema.parse({
  connection: {
    provider: "prometheus",
    baseUrl: "https://metrics.example/prometheus",
    authSecretId: null,
  },
  requestsQuery: "sum(increase(requests_total[60s]))",
  errorsQuery: "sum(increase(errors_total[60s]))",
});
// Synthetic recorded-response fixtures following the documented query_range JSON format.
function matrix(
  values: [number, string][],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    status: "success",
    data: { resultType: "matrix", result: [{ metric: {}, values }] },
    ...extra,
  });
}
const requests = matrix([
  [start, "100"],
  [start + 60, "120"],
  [start + 120, "80"],
]);
const errors = matrix([
  [start, "1"],
  [start + 60, "12"],
  [start + 120, "0"],
]);
const use = (signal = new AbortController().signal) => ({
  workspaceId: workspaceIdSchema.parse("org_one"),
  workId: "metrics-job",
  claimToken: "lease",
  signal,
});
test("paired metrics preserve count samples and stable query/range provenance", () => {
  const result = normalizeMetricCounts(config, range, requests, errors);
  assert.deepEqual(
    result.samples.map((s) => [s.requests, s.errors, s.quality]),
    [
      [100, 1, "complete"],
      [120, 12, "complete"],
      [80, 0, "complete"],
    ],
  );
  assert.match(result.provenance.requestsQueryHash, /^[a-f0-9]{64}$/);
  assert.notEqual(
    result.provenance.requestsQueryHash,
    result.provenance.errorsQueryHash,
  );
  assert.deepEqual(result.provenance.range, range);
  assert.equal(JSON.stringify(result).includes(config.requestsQuery), false);
});
test("gaps, NaN and invalid denominators remain unknown instead of healthy zeros", () => {
  const result = normalizeMetricCounts(
    config,
    range,
    matrix([
      [start, "NaN"],
      [start + 120, "2"],
    ]),
    errors,
  );
  assert.deepEqual(
    result.samples.map((s) => s.quality),
    ["nonfinite", "missing", "complete"],
  );
  assert.equal(result.samples[1].requests, null);
  const invalid = normalizeMetricCounts(
    config,
    range,
    matrix([
      [start, "0"],
      [start + 60, "-1"],
      [start + 120, "1e100"],
    ]),
    errors,
  );
  assert.ok(invalid.samples.every((s) => s.quality === "invalid_counts"));
  const annotations = normalizeMetricCounts(
    config,
    range,
    matrix([[start, "100"]], { warnings: ["partial remote storage"] }),
    errors,
  );
  assert.ok(
    annotations.samples.every((s) => s.quality === "provider_annotation"),
  );
});
test("malformed, duplicate, off-grid, multi-series and histogram responses are rejected", () => {
  const two = JSON.parse(requests);
  two.data.result.push(two.data.result[0]);
  const hist = JSON.parse(requests);
  hist.data.result[0].histograms = [];
  for (const raw of [
    "{}",
    matrix([[start, ""]]),
    matrix([[start, "0x10"]]),
    matrix([
      [start, "1"],
      [start, "2"],
    ]),
    matrix([[start + 1, "1"]]),
    JSON.stringify(two),
    JSON.stringify(hist),
  ]) {
    assert.throws(() => normalizeMetricCounts(config, range, raw, errors), {
      message: "invalid_response",
    });
  }
});
test("Grafana uses only its fixed datasource proxy and encoded read-only range query", async () => {
  const seen: ProbeRequest[] = [];
  const reader = new PrometheusMetricsReader({
    exchange: async (request) => {
      seen.push(structuredClone(request));
      return { status: 200, body: seen.length === 1 ? requests : errors };
    },
  });
  const grafana = metricsQuerySchema.parse({
    ...config,
    connection: {
      provider: "grafana-prometheus",
      baseUrl: "https://grafana.example/subpath/",
      authSecretId: null,
      datasourceUid: "prometheus-1",
    },
  });
  const result = await reader.read(grafana, range, use());
  assert.equal(result.provenance.datasourceUid, "prometheus-1");
  assert.equal(seen.length, 2);
  for (const request of seen) {
    const url = new URL(request.url);
    assert.equal(
      url.pathname,
      "/subpath/api/datasources/proxy/uid/prometheus-1/api/v1/query_range",
    );
    assert.equal(request.method, "GET");
    assert.equal(request.body, null);
    assert.equal(url.searchParams.get("step"), "60");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(request.maxResponseBytes, 262144);
  }
  assert.equal(
    new URL(seen[0].url).searchParams.get("query"),
    config.requestsQuery,
  );
  assert.throws(() =>
    metricsQuerySchema.parse({
      ...grafana,
      connection: { ...grafana.connection, datasourceUid: "../other" },
    }),
  );
});
test("metrics credentials are claim-bound, require TLS, and never enter results or retained headers", async () => {
  let claims = 0;
  const seen: ProbeRequest[] = [];
  const reader = new PrometheusMetricsReader(
    {
      exchange: async (request) => {
        assert.equal(request.headers.authorization, "Bearer private-token");
        seen.push(request);
        return { status: 200, body: requests };
      },
    },
    {
      withSecret: async (request, consume) => {
        claims++;
        assert.equal(request.workspaceId, "org_one");
        assert.equal(request.workId, "metrics-job");
        assert.equal(request.secretId, "secret");
        return consume(
          new TextEncoder().encode(
            JSON.stringify({ authorization: "Bearer private-token" }),
          ),
        );
      },
    },
  );
  const authenticated = {
    ...config,
    connection: { ...config.connection, authSecretId: "secret" },
  };
  const result = await reader.read(authenticated, range, use());
  assert.equal(claims, 1);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((r) => r.headers.authorization === undefined));
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  await assert.rejects(
    reader.read(
      {
        ...authenticated,
        connection: {
          ...authenticated.connection,
          baseUrl: "http://metrics.example",
        },
      },
      range,
      use(),
    ),
    { message: "destination_denied" },
  );
  assert.equal(claims, 1);
});
test("provider errors and cancellation are static and never become empty healthy results", async () => {
  const failure = new PrometheusMetricsReader({
    exchange: async () => ({ status: 503, body: "private server trace" }),
  });
  await assert.rejects(failure.read(config, range, use()), {
    message: "provider_unavailable",
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(failure.read(config, range, use(abort.signal)), {
    message: "cancelled",
  });
  const during = new AbortController();
  const reader = new PrometheusMetricsReader({
    exchange: async () => {
      during.abort();
      return { status: 200, body: requests };
    },
  });
  await assert.rejects(reader.read(config, range, use(during.signal)), {
    message: "cancelled",
  });
});
