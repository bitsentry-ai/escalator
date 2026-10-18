import type { PoolClient } from "pg";
import {
  deploymentCoverageDecisionSchema,
  configuredPolicySchema,
  scheduleSchema,
  responderSchema,
  availabilitySchema,
  configuredContactSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  CoverageRecordStore,
  CoverageRecord,
} from "@bitsentry-escalator/features/application";
/** One READ COMMITTED statement captures all evidence; no schedule/business rules in SQL. */
const evidenceSql = `WITH policy AS MATERIALIZED (
 SELECT data FROM escalator_policy WHERE workspace_id=$1 AND id=$2
), schedules AS MATERIALIZED (
 SELECT s.data FROM escalator_schedule s,policy p
 WHERE s.workspace_id=$1 AND s.id IN(p.data->>'primaryScheduleId',p.data->>'peerScheduleId')
), candidate_ids AS MATERIALIZED (
 SELECT DISTINCT id COLLATE "C" AS id FROM (
  SELECT $3::text AS id
  UNION ALL SELECT jsonb_array_elements_text(data->'fallbackResponderIds') FROM policy
  UNION ALL SELECT jsonb_array_elements_text(rotation->'responders') FROM schedules,
   LATERAL jsonb_array_elements(data->'rotations') rotation
  UNION ALL SELECT override->>'responderId' FROM schedules,
   LATERAL jsonb_array_elements(data->'overrides') override
 ) candidates WHERE id IS NOT NULL ORDER BY 1 LIMIT 104
), selected_ids AS MATERIALIZED (
 SELECT id FROM candidate_ids ORDER BY id COLLATE "C" LIMIT 103
), responders AS MATERIALIZED (
 SELECT jsonb_build_object('id',r.id,'hostUserId',r.host_user_id,'displayName',r.display_name,
  'timeZone',r.time_zone,'role',r.role,'enabled',r.enabled,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS data
 FROM escalator_responder r JOIN selected_ids i ON i.id=r.id WHERE r.workspace_id=$1
), availability AS MATERIALIZED (
 SELECT a.data FROM escalator_availability a JOIN selected_ids i ON i.id=a.id WHERE a.workspace_id=$1
), contacts AS MATERIALIZED (
 SELECT c.data FROM escalator_contact c JOIN selected_ids i ON i.id=c.responder_id
 WHERE c.workspace_id=$1 ORDER BY c.id COLLATE "C" LIMIT 2061
)
SELECT (SELECT data FROM policy) AS policy,
 COALESCE((SELECT jsonb_agg(data) FROM schedules),'[]'::jsonb) AS schedules,
 COALESCE((SELECT jsonb_agg(data) FROM responders),'[]'::jsonb) AS responders,
 COALESCE((SELECT jsonb_agg(data) FROM availability),'[]'::jsonb) AS availability,
 COALESCE((SELECT jsonb_agg(data) FROM contacts),'[]'::jsonb) AS contacts,
 (SELECT count(*)<=103 FROM candidate_ids) AND (SELECT count(*)<=2060 FROM contacts) AS complete`;
type EvidenceRow = {
  policy: Record<string, unknown> | null;
  schedules: Record<string, unknown>[];
  responders: Record<string, unknown>[];
  availability: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  complete: boolean;
};
type DecisionRow = {
  data: Record<string, unknown>;
  idempotency_key: string;
  request_hash: string;
};
export function postgresCoverageStore(
  connection: PoolClient,
  scope: WorkspaceId,
): CoverageRecordStore {
  const parse = (row: DecisionRow): CoverageRecord => ({
    decision: deploymentCoverageDecisionSchema.parse({
      ...row.data,
      binding: {
        ...(row.data.binding as Record<string, unknown>),
        workspaceId: scope,
      },
    }),
    key: row.idempotency_key,
    requestHash: row.request_hash,
  });
  return {
    async snapshot(target, mappedDeployerId) {
      const { rows } = await connection.query<EvidenceRow>(evidenceSql, [
        scope,
        target.policyId,
        mappedDeployerId,
      ]);
      const row = rows[0];
      if (!row) throw new Error("Coverage snapshot unavailable");
      const scoped = (data: Record<string, unknown>) => ({
        ...data,
        workspaceId: scope,
      });
      return {
        complete: row.complete,
        policy: row.policy
          ? configuredPolicySchema.parse(scoped(row.policy))
          : null,
        schedules: row.schedules.map((data) =>
          scheduleSchema.parse(scoped(data)),
        ),
        responders: row.responders.map((data) =>
          responderSchema.parse(scoped(data)),
        ),
        availability: row.availability.map((data) =>
          availabilitySchema.parse(scoped(data)),
        ),
        contacts: row.contacts
          .slice(0, 2060)
          .map((data) => configuredContactSchema.parse(scoped(data))),
      };
    },
    async get(targetId, id) {
      const result = await connection.query<DecisionRow>(
        "SELECT data,idempotency_key,request_hash FROM escalator_coverage_decision WHERE workspace_id=$1 AND target_id=$2 AND id=$3",
        [scope, targetId, id],
      );
      return result.rows[0] ? parse(result.rows[0]) : undefined;
    },
    async find(targetId, key) {
      const result = await connection.query<DecisionRow>(
        "SELECT data,idempotency_key,request_hash FROM escalator_coverage_decision WHERE workspace_id=$1 AND target_id=$2 AND idempotency_key=$3",
        [scope, targetId, key],
      );
      return result.rows[0] ? parse(result.rows[0]) : undefined;
    },
    async insert(value) {
      const { decision, key, requestHash } = value;
      const binding = Object.fromEntries(
        Object.entries(decision.binding).filter(
          ([key]) => key !== "workspaceId",
        ),
      );
      await connection.query(
        `INSERT INTO escalator_coverage_decision(workspace_id,id,target_id,service_id,environment_id,policy_id,mapped_deployer_id,override_actor_id,idempotency_key,request_hash,evaluated_at,expires_at,data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz,$13::jsonb)`,
        [
          scope,
          decision.id,
          binding.targetId,
          binding.serviceId,
          binding.environmentId,
          binding.policyId,
          binding.mappedDeployerId,
          decision.override?.responderId ?? null,
          key,
          requestHash,
          decision.evaluatedAt,
          decision.expiresAt,
          JSON.stringify({ ...decision, binding }),
        ],
      );
    },
  };
}
