import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  workspaceIdSchema,
  ruleHistoryQuerySchema,
} from "@bitsentry-escalator/features/contracts";
import { PostgresRuleHistoryRepository } from "../../src/platform/database/rule-history.repository.js";
import { ruleHistorySql } from "../../src/platform/database/rule-history-sql.js";
import { ruleReplayCaptureSql } from "../../src/platform/database/rule-replay-capture-sql.js";
import { mixedParameterCasts } from "./parameter-casts.js";
const scope = workspaceIdSchema.parse("org_a");
const query = ruleHistoryQuerySchema.parse({
  kind: "probe",
  streamId: "probe",
  serviceId: "api",
  environmentId: "prod",
  startAt: "2026-10-07T00:00:00.000Z",
  endAt: "2026-10-07T00:01:00.000Z",
  visibleAt: "2026-10-07T00:02:00.000Z",
});
function fixture(missing = false) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let released = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return {
          rows:
            sql.startsWith("WITH configurations") && !missing
              ? [
                  {
                    snapshot: {
                      workspaceId: scope,
                      ...query,
                      snapshotAt: query.visibleAt,
                      complete: true,
                      configurations: [],
                      receipts: [],
                    },
                  },
                ]
              : [],
        };
      },
      release: () => {
        released++;
      },
    }),
  } as unknown as Pool;
  return {
    repository: new PostgresRuleHistoryRepository(pool),
    calls,
    released: () => released,
  };
}
test("standalone history binds tenant and source values and releases after commit", async () => {
  const f = fixture();
  const result = await f.repository.snapshot(scope, query);
  assert.equal(result.workspaceId, scope);
  assert.deepEqual(
    f.calls.find((row) => row.sql.startsWith("WITH configurations"))!.values,
    [
      scope,
      query.streamId,
      query.serviceId,
      query.environmentId,
      query.startAt,
      query.endAt,
      query.visibleAt,
    ],
  );
  assert.ok(
    f.calls.some(
      (row) => row.sql.includes("app.workspace_id") && row.values[0] === scope,
    ),
  );
  assert.equal(f.calls.at(-1)!.sql, "COMMIT");
  assert.equal(f.released(), 1);
});
test("missing scoped stream rolls back without a fabricated empty history", async () => {
  const f = fixture(true);
  await assert.rejects(f.repository.snapshot(scope, query), {
    code: "not_found",
  });
  assert.equal(f.calls.at(-1)!.sql, "ROLLBACK");
  assert.equal(f.released(), 1);
});
test("invalid history bounds fail before acquiring a connection", async () => {
  const f = fixture();
  assert.throws(() =>
    f.repository.snapshot(scope, { ...query, endAt: query.startAt }),
  );
  assert.deepEqual(f.calls, []);
});
test("history SQL gives every bound parameter a single type", () => {
  for (const kind of ["probe", "metric", "signal"] as const)
    assert.deepEqual(mixedParameterCasts(ruleHistorySql(kind)), [], kind);
});
test("replay capture SQL keeps the history parameter types", () => {
  for (const kind of ["probe", "metric", "signal"] as const)
    assert.deepEqual(mixedParameterCasts(ruleReplayCaptureSql(kind)), [], kind);
});
