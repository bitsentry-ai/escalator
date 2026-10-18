import { createHash } from "node:crypto";
import { z } from "zod";
import {
  metricsQuerySchema,
  metricsRangeSchema,
  type MetricsQuery,
  type MetricsRange,
  type MetricsObservation,
  type MetricCountSample,
} from "../../contracts/metrics.js";
export class MetricsReadError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "provider_unavailable"
      | "secret_unavailable"
      | "destination_denied"
      | "cancelled"
      | "timeout"
      | "invalid_configuration",
  ) {
    super(code);
  }
}
const sample = z.tuple([z.number().finite(), z.string().max(64)]);
const matrix = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z
      .array(
        z.strictObject({
          metric: z.record(z.string().max(128), z.string().max(256)),
          values: z.array(sample).max(1441),
        }),
      )
      .max(1),
  }),
  warnings: z.array(z.string().max(4096)).max(32).optional(),
  infos: z.array(z.string().max(4096)).max(32).optional(),
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function decode(body: string, range: MetricsRange) {
  try {
    if (Buffer.byteLength(body) > 262144) throw new Error();
    const parsed = matrix.parse(JSON.parse(body));
    const series = parsed.data.result[0];
    const points = new Map<number, number | null>();
    let previous = -Infinity;
    if (series) {
      if (Object.keys(series.metric).length > 32) throw new Error();
      const start = Date.parse(range.startAt) / 1000,
        end = Date.parse(range.endAt) / 1000;
      for (const [timestamp, text] of series.values) {
        if (
          !Number.isInteger(timestamp) ||
          timestamp < start ||
          timestamp > end ||
          timestamp <= previous ||
          (timestamp - start) % range.stepSeconds !== 0
        )
          throw new Error();
        previous = timestamp;
        if (["NaN", "+Inf", "-Inf"].includes(text)) points.set(timestamp, null);
        else {
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
            throw new Error();
          const value = Number(text);
          points.set(timestamp, Number.isFinite(value) ? value : null);
        }
      }
    }
    return {
      points,
      annotated: !!(parsed.warnings?.length || parsed.infos?.length),
      seriesHash: series
        ? hash(
            JSON.stringify(
              Object.entries(series.metric).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            ),
          )
        : null,
    };
  } catch {
    throw new MetricsReadError("invalid_response");
  }
}
/** No denominator inference, zero filling, multi-series summation or annotation suppression. */
export function normalizeMetricCounts(
  config: MetricsQuery,
  window: MetricsRange,
  requestsBody: string,
  errorsBody: string,
): MetricsObservation {
  config = metricsQuerySchema.parse(config);
  window = metricsRangeSchema.parse(window);
  const requests = decode(requestsBody, window),
    errors = decode(errorsBody, window);
  const samples: MetricCountSample[] = [];
  for (
    let at = Date.parse(window.startAt) / 1000;
    at <= Date.parse(window.endAt) / 1000;
    at += window.stepSeconds
  ) {
    const count = requests.points.get(at),
      failed = errors.points.get(at);
    const quality: MetricCountSample["quality"] =
      requests.annotated || errors.annotated
        ? "provider_annotation"
        : count === undefined || failed === undefined
          ? "missing"
          : count === null || failed === null
            ? "nonfinite"
            : count < 0 ||
                failed < 0 ||
                count > Number.MAX_SAFE_INTEGER ||
                failed > count
              ? "invalid_counts"
              : "complete";
    samples.push({
      observedAt: new Date(at * 1000).toISOString(),
      requests: count ?? null,
      errors: failed ?? null,
      quality,
    });
  }
  return {
    samples,
    provenance: {
      provider: config.connection.provider,
      datasourceUid:
        config.connection.provider === "grafana-prometheus"
          ? config.connection.datasourceUid
          : null,
      requestsQueryHash: hash(config.requestsQuery),
      errorsQueryHash: hash(config.errorsQuery),
      requestsSeriesHash: requests.seriesHash,
      errorsSeriesHash: errors.seriesHash,
      range: window,
    },
  };
}
