import test from "node:test";
import assert from "node:assert/strict";
import { readHeartbeatForm } from "../src/ui/heartbeats/form.js";
import { heartbeatSchema } from "../src/contracts/index.js";
const initial = heartbeatSchema.parse({
  id: "probe",
  workspaceId: "workspace",
  sourceId: "source",
  serviceId: "service",
  environmentId: "production",
  name: "Nightly job",
  enabled: true,
  intervalSeconds: 3600,
  graceSeconds: 10,
  version: 7,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
});
function form(values: Record<string, string> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    name: "Job",
    service: "service",
    environment: "production",
    interval: "60",
    grace: "10",
    ...values,
  }))
    result.set(key, value);
  return result;
}
test("new heartbeat forms remain disabled and reject timing outside the domain bounds", () => {
  const command = readHeartbeatForm(form({ workspaceId: "foreign" }));
  assert.equal(command.kind, "create");
  assert.equal(command.input.enabled, false);
  assert.equal("workspaceId" in command.input, false);
  assert.throws(() => readHeartbeatForm(form({ interval: "59" })));
  assert.throws(() => readHeartbeatForm(form({ grace: "3601" })));
});
test("heartbeat edits take identity and configuration version from the selected record", () => {
  const command = readHeartbeatForm(
    form({ id: "foreign", expectedVersion: "999", enabled: "on" }),
    initial,
  );
  if (command.kind !== "update") throw new Error("Expected update");
  assert.equal(command.input.id, initial.id);
  assert.equal(command.input.expectedVersion, 7);
  assert.equal(command.input.enabled, true);
  assert.equal("serviceId" in command.input, false);
});
