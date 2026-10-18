import type { PoolClient } from "pg";
import {
  ruleLiveRecordSchema,
  ruleHistorySnapshotSchema,
  type WorkspaceId,
  type RuleLiveRecord,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  type RuleLiveRecordStore,
} from "@bitsentry-escalator/features/application";
import { ruleHistorySql } from "./rule-history-sql.js";
/** Required same-connection policy adapter. No default infers history from current
 * configuration. It locks source/service/binding/policy before the runtime row.
 */
export interface PostgresRulePolicyStore {
  lock(row: RuleLiveRecord): Promise<void>;
  at: RuleLiveRecordStore["policy"];
}
export function postgresRuleLiveStore(
  db: PoolClient,
  scope: WorkspaceId,
  policy: PostgresRulePolicyStore,
): RuleLiveRecordStore {
  const projection = `SELECT r.data || jsonb_build_object(
    'version',jsonb_build_object('id',v.rule_id,'revision',v.revision,
      'definition',v.definition || jsonb_build_object('workspaceId',$1::text)),
    'state',CASE WHEN r.data->'state'='null'::jsonb THEN 'null'::jsonb
      ELSE r.data->'state' || jsonb_build_object('workspaceId',$1::text) END
    ) AS data FROM escalator_rule_runtime r JOIN escalator_rule_version v
    ON (v.workspace_id,v.rule_id,v.revision)=(r.workspace_id,r.rule_id,r.rule_revision)
    WHERE r.workspace_id=$1 AND r.rule_id=$2 AND r.retired_at IS NULL`;
  async function read(id: string, lock = false) {
    const result = await db.query<{ data: unknown }>(
      projection + (lock ? " FOR UPDATE OF r" : ""),
      [scope, id],
    );
    return result.rows[0]
      ? ruleLiveRecordSchema.parse(result.rows[0].data)
      : undefined;
  }
  return {
    async lock(id) {
      const before = await read(id);
      if (!before) return undefined;
      await policy.lock(before);
      const row = await read(id, true);
      // Activation uses this same order. A concurrent change between the first
      // lookup and runtime lock must retry, never evaluate under old scope locks.
      if (
        !row ||
        row.generation !== before.generation ||
        row.version.revision !== before.version.revision
      )
        throw new Error("Rule activation changed during lock acquisition");
      return row;
    },
    async history(query) {
      const result = await db.query<{ snapshot: unknown }>(
        ruleHistorySql(query.kind),
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
      if (!result.rows[0]) throw new PersistenceError("not_found");
      return ruleHistorySnapshotSchema.parse(result.rows[0].snapshot);
    },
    policy: policy.at.bind(policy),
    async save(row, expected) {
      const result = await db.query(
        `UPDATE escalator_rule_runtime SET
        revision=$4::bigint,incident_id=$5,due_at=$6::timestamptz,
        data=($7::jsonb-'version') #- '{state,workspaceId}'
        WHERE workspace_id=$1 AND rule_id=$2 AND generation=$3::bigint
          AND revision=$8::bigint AND retired_at IS NULL`,
        [
          scope,
          row.version.id,
          row.generation,
          row.revision,
          row.incidentId,
          row.dueAt,
          JSON.stringify(row),
          expected,
        ],
      );
      return result.rowCount === 1;
    },
    async decision(row, transition) {
      await db.query(
        `INSERT INTO escalator_rule_decision
        (workspace_id,rule_id,rule_revision,generation,decision_at,data,mode)
        VALUES($1,$2,$3::bigint,$4::bigint,$5::timestamptz,$6::jsonb #- '{state,workspaceId}',$7)`,
        [
          scope,
          row.version.id,
          row.version.revision,
          row.generation,
          transition.state.lastDecisionAt,
          JSON.stringify(transition),
          row.mode,
        ],
      );
    },
  };
}
