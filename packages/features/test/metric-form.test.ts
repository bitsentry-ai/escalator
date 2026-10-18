import test from "node:test";
import assert from "node:assert/strict";
import { readMetricForm } from "../src/ui/metrics/form.js";
import { metricMonitorSchema } from "../src/contracts/index.js";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: "Errors",
    service: "service",
    environment: "production",
    provider: "prometheus",
    url: "https://metrics.example.test",
    requests: "sum(increase(requests_total[60s]))",
    errors: "sum(increase(errors_total[60s]))",
    step: "60",
    window: "300",
    samples: "5",
    minimumRequests: "100",
    floor: "5",
    ...values,
  }))
    data.set(key, value);
  return data;
}
test("metric forms convert the visible percentage and default new monitors to disabled", () => {
  const command = readMetricForm(
    form({ workspaceId: "foreign", authSecretId: "credential" }),
  );
  assert.equal(command.kind, "create");
  assert.equal(command.input.enabled, false);
  assert.equal(command.input.rule.errorRateFloor, 0.05);
  assert.equal(command.input.query.connection.authSecretId, "credential");
  assert.equal("workspaceId" in command.input, false);
  assert.equal("datasourceUid" in command.input.query.connection, false);
});
test("Grafana metrics require a datasource identifier and reject credentials in the URL", () => {
  assert.throws(() => readMetricForm(form({ provider: "grafana-prometheus" })));
  assert.throws(() =>
    readMetricForm(form({ url: "https://user:password@metrics.example.test" })),
  );
  assert.throws(() => readMetricForm(form({ floor: "0" })));
  const command = readMetricForm(
    form({ provider: "grafana-prometheus", datasource: "prometheus-main" }),
  );
  assert.deepEqual(command.input.query.connection, {
    provider: "grafana-prometheus",
    datasourceUid: "prometheus-main",
    baseUrl: "https://metrics.example.test",
    authSecretId: null,
  });
});
test("metric updates preserve selected identity and version independently of form fields", () => {
  const created = readMetricForm(form()).input;
  const initial = metricMonitorSchema.parse({
    ...created,
    id: "metric",
    sourceId: "source",
    workspaceId: "workspace",
    version: 7,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  const command = readMetricForm(
    form({ id: "foreign", expectedVersion: "999", enabled: "on" }),
    initial,
  );
  if (command.kind !== "update") throw new Error("Expected update");
  assert.equal(command.input.id, initial.id);
  assert.equal(command.input.expectedVersion, 7);
  assert.equal("serviceId" in command.input, false);
});
