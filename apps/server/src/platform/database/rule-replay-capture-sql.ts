import type { RuleHistoryQuery } from "@bitsentry-escalator/features/contracts";
import { watchMeasurementFields } from "@bitsentry-escalator/features/application";
import { ruleHistorySql } from "./rule-history-sql.js";
const tables = {
  probe: "escalator_probe",
  metric: "escalator_metric_monitor",
  signal: "escalator_signal_source",
} as const;
/** One database snapshot for evidence and policy. Parameters match history SQL,
 * followed by the last simulated decision; no provider query text is executed. */
export function ruleReplayCaptureSql(kind: RuleHistoryQuery["kind"]) {
  const fields = kind === "signal" ? [] : watchMeasurementFields[kind];
  const projection = fields.map((f) => `'${f}',t.data->'${f}'`).join(",");
  const hash = `encode(sha256(convert_to(jsonb_build_object(${projection})::text,'UTF8')),'hex')`;
  const scope =
    "workspace_id=$1 AND service_id=$3 AND (environment_id=$4 OR environment_id IS NULL)";
  return `WITH history AS (${ruleHistorySql(kind)}), prior AS (
    SELECT DISTINCT ON (kind,entity_id) * FROM escalator_rule_policy_fact
    WHERE ${scope} AND recorded_at<$5::text::timestamptz
    ORDER BY kind,entity_id,recorded_at DESC,id DESC
  ), facts AS MATERIALIZED (
    SELECT * FROM (SELECT * FROM prior UNION ALL
      SELECT * FROM escalator_rule_policy_fact WHERE ${scope} AND recorded_at>=$5::text::timestamptz AND recorded_at<=$8::timestamptz
    ) f ORDER BY recorded_at,id LIMIT 10001
  ) SELECT jsonb_build_object('history',h.snapshot,'policyComplete',(SELECT count(*)<=10000 FROM facts),
    'measurementHash',${hash},'policyFacts',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',id::text,'workspaceId',$1::text,'kind',kind,'entityId',entity_id,'serviceId',service_id,
      'environmentId',environment_id,'sourceId',source_id,'policyId',policy_id,'enabled',enabled,'deleted',deleted,
      'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY recorded_at,id)
      FROM (SELECT * FROM facts ORDER BY recorded_at,id LIMIT 10000) f),'[]'::jsonb)) AS evidence
    FROM history h CROSS JOIN ${tables[kind]} t
    WHERE t.workspace_id=$1 AND t.id=$2 AND t.service_id=$3 AND t.environment_id=$4`;
}
