import { storableText, unicodeMessage } from "./text.js";
import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const connection = {
  baseUrl: z
    .string()
    .url()
    .max(1024)
    .refine((value) => {
      try {
        const url = new URL(value);
        if (!storableText(value)) return false;
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  authSecretId: opaqueIdSchema.nullable(),
};
export const metricsConnectionSchema = z.discriminatedUnion("provider", [
  z.strictObject({ ...connection, provider: z.literal("prometheus") }),
  z.strictObject({
    ...connection,
    provider: z.literal("grafana-prometheus"),
    datasourceUid: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  }),
]);
const expression = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(storableText, unicodeMessage)
  .refine((value) =>
    Array.from(value).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }),
  );
/** Each expression must return one aggregate count series, not rates or cumulative counters. */
export const metricsQuerySchema = z.strictObject({
  connection: metricsConnectionSchema,
  requestsQuery: expression,
  errorsQuery: expression,
});
export const metricsRangeSchema = z
  .strictObject({
    startAt: utcTimestampSchema,
    endAt: utcTimestampSchema,
    stepSeconds: z.number().int().min(60).max(3600),
  })
  .refine((value) => {
    const start = Date.parse(value.startAt),
      end = Date.parse(value.endAt);
    return (
      start % 1000 === 0 &&
      end % 1000 === 0 &&
      end >= start &&
      end - start <= 86400000 &&
      (end - start) % (value.stepSeconds * 1000) === 0
    );
  });
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
export type MetricsRange = z.infer<typeof metricsRangeSchema>;
export interface MetricCountSample {
  observedAt: string;
  requests: number | null;
  errors: number | null;
  quality:
    | "complete"
    | "missing"
    | "nonfinite"
    | "invalid_counts"
    | "provider_annotation";
}
export interface MetricsProvenance {
  provider: MetricsQuery["connection"]["provider"];
  datasourceUid: string | null;
  requestsQueryHash: string;
  errorsQueryHash: string;
  requestsSeriesHash: string | null;
  errorsSeriesHash: string | null;
  range: MetricsRange;
}
export interface MetricsObservation {
  samples: MetricCountSample[];
  provenance: MetricsProvenance;
}
