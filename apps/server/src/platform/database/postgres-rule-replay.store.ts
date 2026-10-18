import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  decodeRuleReplayRun,
  decodeRuleReplaySnapshot,
  encodeRuleReplayData,
  type RuleReplayStore,
} from "@bitsentry-escalator/features/application";
export function postgresRuleReplayStore(
  db: PoolClient,
  scope: WorkspaceId,
): RuleReplayStore {
  return {
    async currentTime() {
      const result = await db.query<{ now: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
      );
      if (!result.rows[0]) throw new Error("Database time unavailable");
      return result.rows[0].now;
    },
    async lock(id) {
      const result = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_replay_run WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, id],
      );
      return result.rows[0]
        ? decodeRuleReplayRun(scope, result.rows[0].data)
        : undefined;
    },
    async snapshot(id) {
      const result = await db.query<{ data: unknown }>(
        `SELECT jsonb_build_object('snapshot',data,'inputHash',input_hash) AS data FROM escalator_rule_replay_snapshot WHERE workspace_id=$1 AND id=$2`,
        [scope, id],
      );
      return result.rows[0]
        ? decodeRuleReplaySnapshot(scope, result.rows[0].data)
        : undefined;
    },
    async append(row) {
      const data = encodeRuleReplayData(scope, "chunk", row);
      await db.query(
        `INSERT INTO escalator_rule_replay_chunk(workspace_id,run_id,batch,snapshot_id,data) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [scope, row.runId, row.batch, row.snapshotId, data],
      );
    },
    async save(row, expected) {
      const data = encodeRuleReplayData(scope, "run", row);
      const result = await db.query(
        `UPDATE escalator_rule_replay_run SET revision=$3::bigint,status=$4,next_batch=$5,data=$6::jsonb WHERE workspace_id=$1 AND id=$2 AND revision=$7::bigint AND status IN ('queued','running')`,
        [
          scope,
          row.id,
          row.revision,
          row.status,
          row.nextBatch,
          data,
          expected,
        ],
      );
      return result.rowCount === 1;
    },
  };
}
