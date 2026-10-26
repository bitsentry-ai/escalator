import { z } from "zod";
import {
  metricsQuerySchema,
  metricsRangeSchema,
  type MetricsQuery,
  type MetricsRange,
  type MetricsObservation,
} from "../../contracts/metrics.js";
import { opaqueIdSchema, workspaceIdSchema } from "../../contracts/identity.js";
import type { SecretStore } from "../../application/ports/secrets.js";
import type { ProbeExecution } from "../../application/probes/http-runner.js";
import {
  ProbeTransportError,
  type ProbeTransport,
} from "../../application/probes/transport.js";
import { MetricsReadError, normalizeMetricCounts } from "./normalize.js";
function transportFailure(
  reason: string,
): "destination_denied" | "timeout" | "provider_unavailable" {
  if (reason === "destination_denied" || reason === "timeout") return reason;
  return "provider_unavailable";
}
const credential = z.strictObject({
  authorization: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x20-\x7e]+$/),
});
/** Only the Prometheus query_range protocol, directly or through a configured Grafana datasource. */
export class PrometheusMetricsReader {
  constructor(
    private readonly transport: ProbeTransport,
    private readonly secrets?: SecretStore,
  ) {}
  async read(
    input: MetricsQuery,
    range: MetricsRange,
    use: ProbeExecution,
  ): Promise<MetricsObservation> {
    let config: MetricsQuery;
    try {
      config = metricsQuerySchema.parse(input);
      range = metricsRangeSchema.parse(range);
      workspaceIdSchema.parse(use.workspaceId);
      opaqueIdSchema.parse(use.workId);
    } catch {
      throw new MetricsReadError("invalid_configuration");
    }
    if (use.signal.aborted) throw new MetricsReadError("cancelled");
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    use.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 10000);
    timer.unref();
    const headers: Record<string, string> = { accept: "application/json" };
    const ensureActive = () => {
      if (use.signal.aborted) throw new MetricsReadError("cancelled");
      if (timedOut) throw new MetricsReadError("timeout");
    };
    const query = async (expression: string) => {
      ensureActive();
      const url = new URL(config.connection.baseUrl);
      const base = url.pathname.replace(/\/$/, "");
      url.pathname =
        base +
        (config.connection.provider === "grafana-prometheus"
          ? `/api/datasources/proxy/uid/${config.connection.datasourceUid}`
          : "") +
        "/api/v1/query_range";
      url.search = new URLSearchParams({
        query: expression,
        start: String(Date.parse(range.startAt) / 1000),
        end: String(Date.parse(range.endAt) / 1000),
        step: String(range.stepSeconds),
        timeout: "4s",
        limit: "2",
      }).toString();
      if (url.href.length > 4096)
        throw new MetricsReadError("invalid_configuration");
      const response = await this.transport.exchange(
        {
          url: url.href,
          method: "GET",
          headers,
          body: null,
          timeoutMs: 5000,
          maxResponseBytes: 262144,
        },
        abort.signal,
      );
      ensureActive();
      if (response.status !== 200)
        throw new MetricsReadError("provider_unavailable");
      return response.body;
    };
    const run = async () =>
      normalizeMetricCounts(
        config,
        range,
        await query(config.requestsQuery),
        await query(config.errorsQuery),
      );
    try {
      if (!config.connection.authSecretId) {
        const result = await run();
        ensureActive();
        return result;
      }
      if (new URL(config.connection.baseUrl).protocol !== "https:")
        throw new MetricsReadError("destination_denied");
      if (!this.secrets) throw new MetricsReadError("secret_unavailable");
      const result = await this.secrets.withSecret(
        {
          workspaceId: use.workspaceId,
          secretId: config.connection.authSecretId,
          queue: "job",
          workId: use.workId,
          claimToken: use.claimToken,
          signal: abort.signal,
        },
        async (bytes) => {
          try {
            if (bytes.length > 16384)
              throw new Error("credential exceeds 16 KiB");
            headers.authorization = credential.parse(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ),
            ).authorization;
          } catch {
            throw new MetricsReadError("secret_unavailable");
          }
          try {
            return await run();
          } finally {
            delete headers.authorization;
          }
        },
      );
      ensureActive();
      return result;
    } catch (error) {
      if (use.signal.aborted) throw new MetricsReadError("cancelled");
      if (timedOut) throw new MetricsReadError("timeout");
      if (error instanceof MetricsReadError) throw error;
      if (error instanceof ProbeTransportError)
        throw new MetricsReadError(transportFailure(error.reason));
      throw new MetricsReadError(
        config.connection.authSecretId
          ? "secret_unavailable"
          : "provider_unavailable",
      );
    } finally {
      clearTimeout(timer);
      use.signal.removeEventListener("abort", cancel);
      delete headers.authorization;
    }
  }
}
