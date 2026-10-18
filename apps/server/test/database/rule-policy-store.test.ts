import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  ruleLiveRecordSchema,
  workspaceIdSchema,
} from "@bitsentry-escalator/features/contracts";
import { postgresRulePolicyStore } from "../../src/platform/database/postgres-rule-policy.store.js";
const scope = workspaceIdSchema.parse("org");
function record() {
  return ruleLiveRecordSchema.parse({
    version: {
      id: "rule",
      revision: 1,
      definition: {
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        languageVersion: 1,
        selector: { kind: "probe", streamId: "probe", field: "failure" },
        aggregation: "sum",
        windowSeconds: 60,
        stepSeconds: 60,
        minimumSamples: 1,
        trigger: { operator: "gte", value: 1 },
        recovery: { operator: "lt", value: 1 },
        persistenceSeconds: 0,
        recoverySeconds: 0,
        cooldownSeconds: 0,
        severity: "high",
      },
    },
    generation: 1,
    revision: 1,
    mode: "shadow",
    title: "Probe",
    measurementHash: "a".repeat(64),
    state: null,
    incidentId: null,
    dueAt: "2026-10-07T00:01:00.000Z",
    jobId: "job",
  });
}
function fixture(changed = false) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("AS source_id"))
      return {
        rows: [
          {
            source_id:
              changed && sql.includes("FOR SHARE") ? "other" : "source",
          },
        ],
      };
    if (sql.includes("SELECT id,policy_id"))
      return { rows: [{ id: "binding", policy_id: "policy" }] };
    if (sql.startsWith("SELECT id FROM")) return { rows: [{ id: "present" }] };
    return { rows: [] };
  };
  const db = { query } as unknown as PoolClient;
  return { store: postgresRulePolicyStore(db, scope), calls };
}
test("policy locks source before stream and observes legacy facts only after configuration locks", async () => {
  const f = fixture();
  await f.store.lock(record());
  assert.match(f.calls[1]!.sql, /escalator_signal_source.*FOR UPDATE/);
  assert.match(f.calls[2]!.sql, /escalator_probe.*FOR SHARE/);
  assert.match(f.calls[5]!.sql, /escalator_policy.*FOR SHARE/);
  const observed = f.calls.filter((call) =>
    call.sql.includes("escalator_observe_rule_policy"),
  );
  assert.deepEqual(
    observed.map((call) => call.values),
    [
      ["signal", "source"],
      ["service", "api"],
      ["probe", "probe"],
      ["binding", "binding"],
      ["policy", "policy"],
    ],
  );
  assert.ok(f.calls.slice(0, 6).every((call) => call.values[0] === scope));
});
test("a stream relinked while locking retries before recording policy facts", async () => {
  const f = fixture(true);
  await assert.rejects(f.store.lock(record()), /binding changed/);
  assert.equal(
    f.calls.some((call) => call.sql.includes("escalator_observe_rule_policy")),
    false,
  );
});
test("current locks do not fabricate a known historical policy", async () => {
  const f = fixture(),
    row = record();
  await f.store.lock(row);
  assert.deepEqual(await f.store.at(row, row.dueAt), {
    known: false,
    enabled: false,
    maintenance: false,
  });
  assert.deepEqual(f.calls.at(-1)!.values, [
    scope,
    "probe",
    "probe",
    "api",
    "prod",
    row.dueAt,
  ]);
});
test("wrong-tenant policy requests fail before issuing SQL", async () => {
  const f = fixture(),
    row = record();
  row.version.definition.workspaceId = workspaceIdSchema.parse("other");
  await assert.rejects(f.store.lock(row), { code: "scope_violation" });
  await assert.rejects(f.store.at(row, row.dueAt), { code: "scope_violation" });
  assert.deepEqual(f.calls, []);
});
