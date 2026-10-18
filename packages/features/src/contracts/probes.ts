import { storableText, unicodeMessage } from "./text.js";
import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
const scalar = z.union([
  z.string().max(1000).refine(storableText, unicodeMessage),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const path = z
  .array(
    z.union([
      z.string().min(1).max(100).refine(storableText, unicodeMessage),
      z.number().int().min(0).max(10000),
    ]),
  )
  .min(1)
  .max(8);
export const probeJsonAssertionSchema = z.discriminatedUnion("operator", [
  z.strictObject({ path, operator: z.literal("equals"), value: scalar }),
  z.strictObject({
    path,
    operator: z.enum(["gte", "lte"]),
    value: z.number().finite(),
  }),
]);
export const probeAssertionsSchema = z.strictObject({
  status: z
    .array(z.number().int().min(100).max(599))
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length),
  contains: z
    .string()
    .min(1)
    .max(1000)
    .refine(storableText, unicodeMessage)
    .nullable(),
  json: z.array(probeJsonAssertionSchema).max(16),
});
/** Every POST is a deliberate synthetic write, with an application marker and stable request key. */
export const syntheticWriteSchema = z.strictObject({
  markerPath: path,
  markerValue: scalar.refine(
    (value) => value !== null && value !== false && value !== "" && value !== 0,
    "Use an explicit test marker",
  ),
  idempotencyHeader: z.enum(["Idempotency-Key", "X-Idempotency-Key"]),
  cleanupGuidance: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine(storableText, unicodeMessage),
});
export const httpProbeConfigSchema = z
  .strictObject({
    url: z
      .string()
      .url()
      .max(4096)
      .refine(storableText, unicodeMessage)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.href.length <= 4096 &&
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, "Expected an HTTP(S) destination without embedded credentials"),
    method: z.enum(["GET", "HEAD", "POST"]),
    body: z.string().max(16384).refine(storableText, unicodeMessage).nullable(),
    authSecretId: opaqueIdSchema.nullable(),
    timeoutMs: z.number().int().min(100).max(10000),
    maxResponseBytes: z.number().int().min(1).max(262144),
    assertions: probeAssertionsSchema,
    syntheticWrite: syntheticWriteSchema.nullable(),
  })
  .refine(
    (value) =>
      value.method === "POST"
        ? value.syntheticWrite !== null && value.body !== null
        : value.syntheticWrite === null && value.body === null,
    "Synthetic writes require explicit setup; read probes have no body",
  )
  .refine(
    (value) =>
      value.method !== "HEAD" ||
      (value.assertions.contains === null &&
        value.assertions.json.length === 0),
    "HEAD cannot assert a response body",
  );
export const probeSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    sourceId: opaqueIdSchema,
    serviceId: serviceIdSchema,
    environmentId: environmentIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(storableText, unicodeMessage),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(60).max(3600),
    critical: z.boolean(),
    failureThreshold: z.number().int().min(1).max(10),
    recoveryThreshold: z.number().int().min(1).max(10),
    config: httpProbeConfigSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .refine(
    (value) => !value.critical || value.failureThreshold === 1,
    "Critical routes fail on the first failed observation",
  )
  .refine(
    (value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
  );
export type HttpProbeConfig = z.infer<typeof httpProbeConfigSchema>;
export type Probe = z.infer<typeof probeSchema>;
export const probeResultSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    probeId: opaqueIdSchema,
    probeVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    observedAt: utcTimestampSchema,
    outcome: z.enum(["healthy", "failed", "unknown"]),
    reason: z.enum([
      "assertions_passed",
      "status_mismatch",
      "body_mismatch",
      "json_mismatch",
      "invalid_json",
      "network_error",
      "timeout",
      "destination_denied",
      "response_limit",
      "invalid_configuration",
      "secret_unavailable",
      "cancelled",
    ]),
    statusCode: z.number().int().min(100).max(599).nullable(),
    durationMs: z.number().int().min(0).max(60000),
  })
  .refine((value) =>
    value.outcome === "healthy"
      ? value.reason === "assertions_passed" && value.statusCode !== null
      : value.outcome === "failed"
        ? [
            "status_mismatch",
            "body_mismatch",
            "json_mismatch",
            "invalid_json",
            "network_error",
            "timeout",
          ].includes(value.reason)
        : [
            "destination_denied",
            "response_limit",
            "invalid_configuration",
            "secret_unavailable",
            "cancelled",
          ].includes(value.reason),
  );
export type ProbeResult = z.infer<typeof probeResultSchema>;
export const probeStateSchema = z
  .strictObject({
    probeId: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    probeVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    lastResultId: opaqueIdSchema,
    lastObservedAt: utcTimestampSchema,
    active: z.boolean(),
    consecutiveFailures: z.number().int().min(0).max(10),
    consecutiveSuccesses: z.number().int().min(0).max(10),
  })
  .refine(
    (value) =>
      value.consecutiveFailures === 0 || value.consecutiveSuccesses === 0,
  );
export type ProbeState = z.infer<typeof probeStateSchema>;
