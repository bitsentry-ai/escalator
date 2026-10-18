import test from "node:test";
import assert from "node:assert/strict";
import { createMonitoringSecretSchema } from "../src/contracts/monitoring-credentials.js";
import { encodeMonitoringSecret } from "../src/application/secrets/monitoring-secret.js";
test("monitoring credential encoding matches the existing probe, metric and signing adapters", () => {
  const probe = encodeMonitoringSecret({
    name: "API",
    kind: "http-probe",
    credentials: { header: "x-api-key", value: "fixture-key" },
  });
  const metric = encodeMonitoringSecret({
    name: "Metrics",
    kind: "metrics",
    credentials: { authorization: "Bearer fixture-token" },
  });
  const signing = encodeMonitoringSecret({
    name: "Webhook",
    kind: "provider-signing",
    credentials: { key: "fixture-signing-key" },
  });
  try {
    assert.deepEqual(JSON.parse(new TextDecoder().decode(probe)), {
      header: "x-api-key",
      value: "fixture-key",
    });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(metric)), {
      authorization: "Bearer fixture-token",
    });
    assert.equal(new TextDecoder().decode(signing), "fixture-signing-key");
  } finally {
    probe.fill(0);
    metric.fill(0);
    signing.fill(0);
  }
});
test("monitoring credentials reject header injection, caller scope, incompatible fields and oversized signing bytes", () => {
  const input = {
    name: "API",
    kind: "http-probe",
    credentials: { header: "authorization", value: "Bearer fixture" },
  };
  assert.equal(createMonitoringSecretSchema.safeParse(input).success, true);
  assert.equal(
    createMonitoringSecretSchema.safeParse({ ...input, workspaceId: "other" })
      .success,
    false,
  );
  assert.equal(
    createMonitoringSecretSchema.safeParse({
      ...input,
      credentials: { ...input.credentials, value: "value\r\nHost: internal" },
    }).success,
    false,
  );
  assert.equal(
    createMonitoringSecretSchema.safeParse({
      ...input,
      credentials: { header: "cookie", value: "fixture" },
    }).success,
    false,
  );
  assert.equal(
    createMonitoringSecretSchema.safeParse({
      name: "MAC",
      kind: "provider-signing",
      credentials: { key: "界".repeat(1366) },
    }).success,
    false,
  );
});
