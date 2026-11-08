import test from "node:test";
import assert from "node:assert/strict";
import { resolveResponse } from "@trpc/server/http";
import { RuleRequestError } from "@bitsentry-escalator/features/application";
import { appRouter } from "../../src/platform/trpc/router.js";
import { routerContext } from "./router-context.js";

const coded = (code: string) => Object.assign(new Error("private"), { code });
const metricInput = {
  name: "Health",
  serviceId: "api",
  environmentId: "prod",
  enabled: false,
  stepSeconds: 60,
  query: {
    connection: {
      provider: "prometheus",
      baseUrl: "https://example.test",
      authSecretId: null,
    },
    requestsQuery: "requests",
    errorsQuery: "errors",
  },
  rule: {
    windowSeconds: 120,
    minimumSamples: 2,
    minimumRequests: 100,
    errorRateFloor: 0.05,
  },
};
const probeInput = {
  name: "Health",
  serviceId: "api",
  environmentId: "prod",
  enabled: false,
  intervalSeconds: 60,
  critical: false,
  failureThreshold: 2,
  recoveryThreshold: 2,
  config: {
    url: "https://example.test/health",
    method: "GET",
    body: null,
    authSecretId: null,
    timeoutMs: 1000,
    maxResponseBytes: 1000,
    assertions: { status: [200], contains: null, json: [] },
    syntheticWrite: null,
  },
};
const settingsInput = {
  serviceId: "service",
  environmentId: "production",
  enabled: false,
  destination: {
    provider: "ollama",
    model: "local",
    location: "local",
    origin: "http://127.0.0.1:11434",
  },
  endpoint: "http://127.0.0.1:11434",
  secretId: null,
  limits: {
    maxDurationMs: 60000,
    maxModelCalls: 1,
    maxEvidenceReads: 4,
    maxEvidenceBytes: 32768,
    maxOutputTokens: 1024,
    maxTraceEvents: 32,
  },
  sources: [],
};
const scheduleInput = {
  id: "schedule",
  serviceId: "api",
  name: "Primary",
  enabled: true,
  rotations: [],
  overrides: [],
  expectedVersion: null,
};
const capacityLimits = [
  "destination_denied",
  "configured_limit",
  "active_limit",
  "request_budget",
].map((code) => [coded(code), "PRECONDITION_FAILED"] as const);

/** [procedure, use case it calls, input, [thrown error, client code, exact message?][]] */
const cases: [
  string,
  string,
  unknown,
  (readonly [Error, string, string?])[],
][] = [
  [
    "services.list",
    "services.listServices",
    {},
    [
      [coded("not_found"), "NOT_FOUND"],
      [coded("forbidden"), "FORBIDDEN"],
      [coded("already_exists"), "CONFLICT"],
    ],
  ],
  [
    "configuration.writeSchedule",
    "configuration.writeSchedule",
    scheduleInput,
    [
      [coded("conflict"), "CONFLICT"],
      [coded("stale_preview"), "PRECONDITION_FAILED"],
      [coded("invalid_schedule"), "BAD_REQUEST"],
      [coded("invalid_configuration"), "BAD_REQUEST"],
    ],
  ],
  [
    "incidents.create",
    "incidents.create",
    {
      requestId: "manual",
      serviceId: "api",
      environmentId: "prod",
      policyId: "policy",
      title: "Outage",
      severity: "critical",
    },
    [[coded("paging_unavailable"), "PRECONDITION_FAILED"]],
  ],
  [
    "deployments.issueGrant",
    "deployments.issueToken",
    { targetId: "target", capabilities: ["deployment:write"] },
    [
      [coded("disabled"), "PRECONDITION_FAILED"],
      [coded("invalid_responder"), "BAD_REQUEST"],
      [coded("forbidden"), "FORBIDDEN"],
      [coded("conflict"), "CONFLICT"],
    ],
  ],
  [
    "deployments.overrideCoverage",
    "deploymentPreflight.override",
    {
      targetId: "target",
      decisionId: "decision",
      key: "override",
      reason: "Emergency",
    },
    [[coded("idempotency_conflict"), "CONFLICT"]],
  ],
  [
    "labels.review",
    "labels.review",
    { id: "label", expectedRevision: 1 },
    [
      [coded("immutable"), "CONFLICT"],
      [coded("conflict"), "CONFLICT"],
      [coded("forbidden"), "FORBIDDEN"],
      [coded("not_found"), "NOT_FOUND"],
    ],
  ],
  ["metrics.create", "metrics.create", metricInput, capacityLimits],
  ["probes.create", "probes.create", probeInput, capacityLimits],
  [
    "retention.get",
    "retention.get",
    undefined,
    [
      [coded("retention_busy"), "TOO_MANY_REQUESTS"],
      [new RangeError("private"), "BAD_REQUEST"],
    ],
  ],
  [
    "heartbeats.issueGrant",
    "heartbeats.issueGrant",
    { id: "heartbeat", expiresAt: "2026-10-03T00:00:00.000Z" },
    [[coded("invalid_expiry"), "BAD_REQUEST"]],
  ],
  [
    "signals.issueToken",
    "signals.issueToken",
    { sourceId: "source" },
    [
      [
        coded("source_disabled"),
        "PRECONDITION_FAILED",
        "Source cannot accept ingestion grants",
      ],
    ],
  ],
  [
    "signals.revokeToken",
    "signals.revokeToken",
    { id: "foreign" },
    [[coded("not_found"), "NOT_FOUND"]],
  ],
  [
    "rules.activate",
    "rules.activation.activate",
    { ruleId: "rule", receiptId: "receipt" },
    [
      [
        new RuleRequestError("CONFLICT", "private"),
        "CONFLICT",
        "Rule or evidence changed; refresh and review again",
      ],
    ],
  ],
  [
    "investigationReports.get",
    "investigationReports.read",
    { id: "incident_a" },
    [
      [coded("forbidden"), "FORBIDDEN"],
      [coded("not_found"), "NOT_FOUND"],
      [
        new Error("private"),
        "INTERNAL_SERVER_ERROR",
        "Unable to read investigation report",
      ],
    ],
  ],
  [
    "investigationSettings.create",
    "investigationSettings.create",
    settingsInput,
    [
      [coded("conflict"), "CONFLICT"],
      [coded("not_found"), "NOT_FOUND"],
      [coded("forbidden"), "FORBIDDEN"],
      [new Error("private"), "INTERNAL_SERVER_ERROR"],
    ],
  ],
];

/** Builds { a: { b: { c: fn } } } from "a.b.c". */
function nested(path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  return { [head]: rest.length ? nested(rest.join("."), value) : value };
}

test("domain failures map to bounded client codes without leaking their messages", async () => {
  for (const [path, useCase, input, failures] of cases)
    for (const [error, code, message] of failures) {
      const caller = appRouter.createCaller(
        routerContext(
          nested(useCase, async () => {
            throw error;
          }),
        ),
      );
      const procedure = path
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)[key],
          caller,
        ) as (input: unknown) => Promise<unknown>;
      await assert.rejects(procedure(input), (raw: unknown) => {
        const e = raw as { code: string; message: string };
        const label = `${path} ${error.name} ${(error as { code?: string }).code}`;
        assert.equal(e.code, code, label);
        assert.equal(e.message.includes("private"), false, label);
        if (message) assert.equal(e.message, message, label);
        return true;
      });
    }
});

test("HTTP tRPC errors redact database messages and stack traces without a listener", async () => {
  const response = await resolveResponse({
    router: appRouter,
    path: "services.list",
    req: new globalThis.Request(
      `https://escalator.example/trpc/services.list?input=${encodeURIComponent("{}")}`,
    ),
    createContext: async () =>
      routerContext({
        services: {
          listServices: async () => {
            throw new Error("sensitive-database-connection-material");
          },
        },
      }),
    error: null,
  });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.equal(body.includes("sensitive-database"), false);
  assert.equal(body.includes("stack"), false);
  assert.ok(body.includes("Request failed"));
});
