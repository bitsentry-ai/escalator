import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  workspaceIdSchema,
  ruleLiveRecordSchema,
  ruleHistoryQuerySchema,
} from "@bitsentry-escalator/features/contracts";
import { postgresRuleLiveStore } from "../../src/platform/database/postgres-rule-live.store.js";
const scope = workspaceIdSchema.parse("rules-org"),
  at = "2026-10-07T00:01:00.000Z";
function record() {
  return ruleLiveRecordSchema.parse({
    version: {
      id: "rule",
      revision: 1,
      definition: {
        languageVersion: 1,
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
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
    title: "Probe failures",
    measurementHash: "a".repeat(64),
    state: null,
    incidentId: null,
    dueAt: at,
    jobId: "job",
  });
}
function fixture(changeActivation = false) {
  const calls: { sql: string; values: unknown[] }[] = [],
    order: string[] = [];
  let reads = 0;
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      order.push(sql.includes("FOR UPDATE OF r") ? "runtime-lock" : "sql");
      if (sql.startsWith("SELECT r.data")) {
        reads++;
        return {
          rows: [
            {
              data: {
                ...record(),
                generation: changeActivation && reads > 1 ? 2 : 1,
              },
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const store = postgresRuleLiveStore(db, scope, {
    lock: async () => {
      order.push("policy-lock");
    },
    at: async () => ({ known: false, enabled: false, maintenance: false }),
  });
  return { store, calls, order };
}
test("policy scope locks precede the runtime row and all lookups bind the tenant", async () => {
  const f = fixture();
  assert.equal((await f.store.lock("rule"))?.generation, 1);
  assert.deepEqual(f.order, ["sql", "policy-lock", "runtime-lock"]);
  assert.ok(
    f.calls.every(
      (call) => call.values[0] === scope && call.values[1] === "rule",
    ),
  );
});
test("activation changing between lookup and row lock is retried instead of evaluated", async () => {
  const f = fixture(true);
  await assert.rejects(f.store.lock("rule"), /activation changed/);
});
test("CAS writes bind both generation and expected revision and exclude retired rules", async () => {
  const f = fixture(),
    row = { ...record(), revision: 2 };
  assert.equal(await f.store.save(row, 1), true);
  const call = f.calls[0];
  assert.deepEqual(call.values.slice(0, 4), [scope, "rule", 1, 2]);
  assert.equal(call.values[7], 1);
  assert.match(call.sql, /retired_at IS NULL/);
  assert.match(call.sql, /\{state,workspaceId\}/);
  assert.match(call.sql, /-'version'/);
});
test("missing retained stream fails on the same connection rather than fabricating coverage", async () => {
  const f = fixture(),
    query = ruleHistoryQuerySchema.parse({
      kind: "probe",
      streamId: "probe",
      serviceId: "api",
      environmentId: "prod",
      startAt: "2026-10-07T00:00:00.000Z",
      endAt: at,
      visibleAt: at,
    });
  await assert.rejects(f.store.history(query), { code: "not_found" });
  assert.deepEqual(f.calls[0].values, [
    scope,
    "probe",
    "api",
    "prod",
    query.startAt,
    at,
    at,
  ]);
  assert.equal(f.calls.length, 1);
});
