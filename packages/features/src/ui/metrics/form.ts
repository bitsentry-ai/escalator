import {
  createMetricSchema,
  updateMetricSchema,
  type MetricMonitor,
} from "../../contracts/index.js";
export function readMetricForm(form: FormData, initial?: MetricMonitor) {
  const text = (key: string) => String(form.get(key) ?? "");
  const number = (key: string) => Number(text(key));
  const provider = text("provider");
  const connection = {
    provider,
    baseUrl: text("url"),
    authSecretId: text("authSecretId") || null,
    ...(provider === "grafana-prometheus"
      ? { datasourceUid: text("datasource") }
      : {}),
  };
  const editable = {
    name: text("name"),
    enabled: form.get("enabled") === "on",
    stepSeconds: number("step"),
    query: {
      connection,
      requestsQuery: text("requests"),
      errorsQuery: text("errors"),
    },
    rule: {
      windowSeconds: number("window"),
      minimumSamples: number("samples"),
      minimumRequests: number("minimumRequests"),
      errorRateFloor: number("floor") / 100,
    },
  };
  return initial
    ? {
        kind: "update" as const,
        input: updateMetricSchema.parse({
          ...editable,
          id: initial.id,
          expectedVersion: initial.version,
        }),
      }
    : {
        kind: "create" as const,
        input: createMetricSchema.parse({
          ...editable,
          serviceId: text("service"),
          environmentId: text("environment"),
        }),
      };
}
