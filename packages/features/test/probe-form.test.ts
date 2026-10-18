import test from "node:test";
import assert from "node:assert/strict";
import { readProbeForm } from "../src/ui/probes/form.js";
import { probeSchema } from "../src/contracts/index.js";
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: "API",
    service: "service",
    environment: "production",
    method: "GET",
    url: "https://example.com/health",
    interval: "60",
    failures: "2",
    recoveries: "2",
    timeout: "5000",
    responseLimit: "65536",
    status: "200, 204",
  }))
    data.set(key, value);
  return data;
}
test("new probes are disabled, critical routes use the first failure, and caller scope is ignored", () => {
  const data = form();
  data.set("workspaceId", "foreign");
  data.set("critical", "on");
  const result = readProbeForm(data);
  assert.equal(result.kind, "create");
  assert.equal(result.input.enabled, false);
  assert.equal(result.input.failureThreshold, 1);
  assert.equal("workspaceId" in result.input, false);
  assert.deepEqual(result.input.config.assertions.status, [200, 204]);
  assert.equal(result.input.config.authSecretId, null);
});
test("updates use the selected probe version and cannot change its service identity", () => {
  const created = readProbeForm(form());
  const initial = probeSchema.parse({
    ...created.input,
    id: "probe",
    sourceId: "source",
    workspaceId: "workspace",
    version: 7,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  const data = form();
  data.set("service", "foreign");
  data.set("expectedVersion", "8");
  data.set("id", "foreign");
  const result = readProbeForm(data, initial);
  assert.equal(result.kind, "update");
  if (result.kind !== "update") throw new Error("Expected update");
  assert.equal(result.input.id, initial.id);
  assert.equal(result.input.expectedVersion, 7);
  assert.equal("serviceId" in result.input, false);
});
test("POST requires deliberate synthetic write configuration; read methods discard write fields", () => {
  const data = form();
  data.set("method", "POST");
  data.set("body", '{"synthetic":true}');
  assert.throws(() => readProbeForm(data));
  data.set("markerPath", '["synthetic"]');
  data.set("markerValue", "true");
  data.set("idempotencyHeader", "Idempotency-Key");
  data.set("cleanup", "Delete test records after one day");
  assert.equal(
    readProbeForm(data).input.config.syntheticWrite?.markerValue,
    true,
  );
  data.set("body", '{"synthetic":false}');
  assert.throws(() => readProbeForm(data));
  data.set("body", '{"synthetic":true}');
  data.set("markerValue", "false");
  assert.throws(() => readProbeForm(data));
  data.set("method", "GET");
  const read = readProbeForm(data).input.config;
  assert.equal(read.syntheticWrite, null);
  assert.equal(read.body, null);
});
test("HEAD clears body assertions; malformed assertions and out-of-range settings are rejected", () => {
  const data = form();
  data.set("json", "invalid");
  assert.throws(() => readProbeForm(data));
  data.set("method", "HEAD");
  data.set("contains", "body");
  assert.deepEqual(readProbeForm(data).input.config.assertions, {
    status: [200, 204],
    contains: null,
    json: [],
  });
  data.set("timeout", "10001");
  assert.throws(() => readProbeForm(data));
});
