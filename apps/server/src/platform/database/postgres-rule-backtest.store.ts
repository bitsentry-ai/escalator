import type { PoolClient } from "pg";
import {
  incidentLabelSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  decodeRuleReplayChunk,
  decodeRuleBacktest,
  encodeRuleBacktest,
  type RuleBacktestStore,
} from "@bitsentry-escalator/features/application";
export function postgresRuleBacktestStore(
  db: PoolClient,
  scope: WorkspaceId,
): RuleBacktestStore {
  return {
    async chunks(runId) {
      const bound = await db.query<{ count: number; bytes: string }>(
        "SELECT count(*)::integer AS count,COALESCE(sum(octet_length(data::text)),0)::text AS bytes FROM escalator_rule_replay_chunk WHERE workspace_id=$1 AND run_id=$2",
        [scope, runId],
      );
      if (
        !bound.rows[0] ||
        bound.rows[0].count > 44641 ||
        Number(bound.rows[0].bytes) > 67108864
      )
        throw new Error("Replay report input bound exceeded");

      const { rows } = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_replay_chunk WHERE workspace_id=$1 AND run_id=$2 ORDER BY batch LIMIT 44642",
        [scope, runId],
      );
      if (rows.length > 44641) throw new Error("Replay chunk bound exceeded");
      return rows.map((r) => decodeRuleReplayChunk(scope, r.data));
    },
    async labels(snapshot) {
      const rule = snapshot.version.definition;
      const { rows } = await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM escalator_incident_label WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND stream_kind=$4 AND stream_id=$5 AND status='reviewed'
    AND (data->>'reviewedAt')::timestamptz<=$6::timestamptz AND (data->>'startedAt')::timestamptz<=$8::timestamptz AND (data->>'endedAt')::timestamptz>$7::timestamptz ORDER BY id LIMIT 1001`,
        [
          scope,
          rule.serviceId,
          rule.environmentId,
          rule.selector.kind,
          rule.selector.streamId,
          snapshot.snapshotAt,
          snapshot.firstDecisionAt,
          snapshot.lastDecisionAt,
        ],
      );
      if (rows.length > 1000) throw new Error("Reviewed label bound exceeded");
      return rows.map((r) =>
        incidentLabelSchema.parse({ ...r.data, workspaceId: scope }),
      );
    },
    async get(runId) {
      const { rows } = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_backtest WHERE workspace_id=$1 AND run_id=$2",
        [scope, runId],
      );
      return rows[0] ? decodeRuleBacktest(scope, rows[0].data) : undefined;
    },
    async insert(row) {
      const data = encodeRuleBacktest(scope, row);
      await db.query(
        "INSERT INTO escalator_rule_backtest(workspace_id,run_id,snapshot_id,input_hash,data) VALUES($1,$2,$3,$4,$5::jsonb)",
        [scope, row.runId, row.snapshotId, row.inputHash, data],
      );
    },
  };
}
