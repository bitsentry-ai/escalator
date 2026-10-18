import {
  createProbeSchema,
  validateSyntheticProbe,
  updateProbeSchema,
  type Probe,
} from "../../contracts/index.js";
/** Validate form values locally; authenticated hosts validate them again. */
export function readProbeForm(values: FormData, initial?: Probe) {
  const text = (key: string) => String(values.get(key) ?? "");
  const method = text("method");
  const critical = values.has("critical");
  const fields = {
    name: text("name"),
    enabled: values.has("enabled"),
    intervalSeconds: Number(text("interval")),
    critical,
    failureThreshold: critical ? 1 : Number(text("failures")),
    recoveryThreshold: Number(text("recoveries")),
    config: {
      url: text("url"),
      method,
      body: method === "POST" ? text("body") : null,
      authSecretId: text("authSecretId").trim() || null,
      timeoutMs: Number(text("timeout")),
      maxResponseBytes: Number(text("responseLimit")),
      assertions: {
        status: text("status")
          .split(",")
          .map((value) => Number(value.trim())),
        contains: method === "HEAD" ? null : text("contains") || null,
        json:
          method === "HEAD"
            ? []
            : (JSON.parse(text("json") || "[]") as unknown),
      },
      syntheticWrite:
        method === "POST"
          ? {
              markerPath: JSON.parse(text("markerPath")) as unknown,
              markerValue: JSON.parse(text("markerValue")) as unknown,
              idempotencyHeader: text("idempotencyHeader"),
              cleanupGuidance: text("cleanup"),
            }
          : null,
    },
  };
  const result = initial
    ? {
        kind: "update" as const,
        input: updateProbeSchema.parse({
          ...fields,
          id: initial.id,
          expectedVersion: initial.version,
        }),
      }
    : {
        kind: "create" as const,
        input: createProbeSchema.parse({
          ...fields,
          serviceId: text("service"),
          environmentId: text("environment"),
        }),
      };
  validateSyntheticProbe(result.input.config);
  return result;
}
