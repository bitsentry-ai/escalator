import type { PoolClient } from "pg";
import {
  ruleRetainedEvidenceSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  encodeRuleReplayData,
  PersistenceError,
  type RuleReplayCaptureStore,
} from "@bitsentry-escalator/features/application";
import { ruleReplayCaptureSql } from "./rule-replay-capture-sql.js";
export function postgresRuleReplayCaptureStore(
  db: PoolClient,
  scope: WorkspaceId,
): RuleReplayCaptureStore {
  return {
    async reserve() {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('rules.replay:'||$1,0))::text",
        [scope],
      );
      const result = await db.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM (SELECT DISTINCT payload->>'runId' FROM escalator_job WHERE workspace_id=$1 AND kind IN ('rules.replay','rules.backtest') AND state IN ('pending','running') LIMIT 3) active`,
        [scope],
      );
      if (!result.rows[0] || result.rows[0].count >= 3)
        throw new Error("Replay capacity exhausted");
    },
    async evidence(version, range) {
      const rule = version.definition;
      if (rule.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const last = new Date(
        Date.parse(range.endAt) + (rule.collectionDelaySeconds ?? 0) * 1000,
      ).toISOString();
      const result = await db.query<{ evidence: unknown }>(
        ruleReplayCaptureSql(rule.selector.kind),
        [
          scope,
          rule.selector.streamId,
          rule.serviceId,
          rule.environmentId,
          range.startAt,
          range.endAt,
          range.visibleAt,
          last,
        ],
      );
      if (!result.rows[0]) throw new PersistenceError("not_found");
      return ruleRetainedEvidenceSchema.parse(result.rows[0].evidence);
    },
    async insert(snapshot, run) {
      const encoded = encodeRuleReplayData(scope, "snapshot", snapshot),
        data = encodeRuleReplayData(scope, "run", run);
      if (
        run.snapshotId !== snapshot.snapshot.snapshotId ||
        run.inputHash !== snapshot.inputHash ||
        run.status !== "queued" ||
        run.revision !== 1 ||
        run.nextBatch !== 0
      )
        throw new Error("Invalid replay creation");
      await db.query(
        `INSERT INTO escalator_rule_replay_snapshot(workspace_id,id,input_hash,service_id,environment_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb->'snapshot')`,
        [
          scope,
          snapshot.snapshot.snapshotId,
          snapshot.inputHash,
          snapshot.snapshot.version.definition.serviceId,
          snapshot.snapshot.version.definition.environmentId,
          encoded,
        ],
      );
      await db.query(
        `INSERT INTO escalator_rule_replay_run(workspace_id,id,snapshot_id,input_hash,revision,status,next_batch,data) VALUES($1,$2,$3,$4,1,'queued',0,$5::jsonb)`,
        [scope, run.id, run.snapshotId, run.inputHash, data],
      );
    },
  };
}
