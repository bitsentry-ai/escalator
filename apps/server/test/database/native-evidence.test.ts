import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationScopeSchema,
  evidenceQuerySchema,
} from "@bitsentry-escalator/features/contracts";
import {
  readNativeEvidence,
  type NativeEvidenceSql,
} from "../../src/platform/database/postgres-native-evidence.js";
const DB = (
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>,
) => ({ query }) as NativeEvidenceSql;
const scope = investigationScopeSchema.parse({
  workspaceId: "org_a",
  serviceId: "api",
  environmentId: "prod",
  incidentId: "incident",
});
const at = "2026-10-01T01:00:00.000Z";
const query = evidenceQuerySchema.parse({
  kind: "alert",
  sourceId: "source",
  window: { from: "2026-10-01T00:00:00.000Z", to: at },
  limit: 1,
});
const row = () => ({
  service_id: "api",
  environment_id: "prod",
  record: {
    id: "signal",
    version: 1,
    serviceId: "api",
    environmentId: "prod",
    sourceId: "source",
    eventId: "event",
    fingerprint: "group",
    observedAt: at,
    receivedAt: at,
    status: "active",
    severity: "critical",
    title: "Errors",
    evidence: {
      summary: "authorization: Bearer private-value",
      attributes: [{ name: "credential", value: "must-not-leak" }],
    },
  },
});
test("native SQL read projects source facts without retaining arbitrary attributes", async () => {
  const db = DB(async (sql, values) => {
    assert.equal(values[0], scope.workspaceId);
    assert.equal(values[1], query.sourceId);
    assert.equal(values[7], 2);
    assert.match(sql, /LIMIT \$8/);
    return { rows: [row()] };
  });
  const result = await readNativeEvidence(db, scope, query, at, 8192);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.doesNotMatch(result.items[0].text, /private-value|must-not-leak/);
  assert.equal(result.items[0].reference.sourceId, "source");
});
test("native SQL read rejects corrupted stored placement and exposes no payload", async () => {
  const bad = row();
  bad.record.serviceId = "other";
  const result = await readNativeEvidence(
    DB(async () => ({ rows: [bad] })),
    scope,
    query,
    at,
    8192,
  );
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable")
    assert.equal(result.unavailable.reason, "invalid_response");
  assert.doesNotMatch(JSON.stringify(result), /private-value|must-not-leak/);
});
test("unsupported native evidence performs no SQL", async () => {
  const result = await readNativeEvidence(
    DB(async () => {
      throw new Error("unexpected SQL");
    }),
    scope,
    { ...query, kind: "log" },
    at,
    8192,
  );
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable")
    assert.equal(result.unavailable.reason, "not_configured");
});
test("native SQL read surfaces storage errors instead of successful empty evidence", async () => {
  await assert.rejects(
    readNativeEvidence(
      DB(async () => {
        throw new Error("storage unavailable");
      }),
      scope,
      query,
      at,
      8192,
    ),
    /storage unavailable/,
  );
});
