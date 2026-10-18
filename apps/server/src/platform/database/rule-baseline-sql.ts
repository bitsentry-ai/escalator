import type { RuleHistoryQuery } from "@bitsentry-escalator/features/contracts";
/** Closed identifiers. Capture shares the history statement's MVCC snapshot;
 * a decision recorded later cannot enter an earlier capture. Parameters 1..8
 * match history/policy capture; 9 is the first simulated decision.
 * Time parameters are cast through text first so their echoes stay ISO. */
export function ruleBaselineSql(kind: RuleHistoryQuery["kind"]): {
  ctes: string;
  value: string;
} {
  const literal = { probe: "probe", metric: "metric", signal: "signal" }[kind];
  return {
    ctes: `baseline_rows AS MATERIALIZED (
   SELECT d.*,v.definition FROM escalator_rule_decision d JOIN escalator_rule_version v
    ON v.workspace_id=d.workspace_id AND v.rule_id=d.rule_id AND v.revision=d.rule_revision
   WHERE d.workspace_id=$1 AND v.service_id=$3 AND v.environment_id=$4
    AND v.definition->'selector'->>'kind'='${literal}' AND v.definition->'selector'->>'streamId'=$2
    AND d.decision_at>=$9::text::timestamptz AND d.decision_at<=$8::text::timestamptz
    AND (d.recorded_at IS NULL OR d.recorded_at<=$7::text::timestamptz)
  ), baseline_groups AS MATERIALIZED (
   SELECT rule_id,rule_revision,generation,mode,definition,count(*)::integer AS decisions,
    count(*) FILTER(WHERE data->>'status'='evaluated' AND data->'verdict'->>'state'<>'insufficient_data')::integer AS evaluated,
    count(*) FILTER(WHERE data->>'status'='suppressed')::integer AS suppressed,
    count(*) FILTER(WHERE data->>'action'='opened')::integer AS opened,
    count(*) FILTER(WHERE data->>'action'='recovered')::integer AS recovered,
    min(decision_at) AS first_at,max(decision_at) AS last_at
   FROM baseline_rows WHERE recorded_at IS NOT NULL AND mode IN ('active','shadow')
   GROUP BY rule_id,rule_revision,generation,mode,definition
   ORDER BY rule_id COLLATE "C",rule_revision,generation,mode LIMIT 1001
  )`,
    value: `jsonb_build_object('basis','recorded_rule_decisions','visibleAt',$7::text,'firstDecisionAt',$9::text,'lastDecisionAt',$8::text,
   'complete',(SELECT count(*)<=1000 FROM baseline_groups),'legacyUnknown',EXISTS(SELECT 1 FROM baseline_rows WHERE recorded_at IS NULL OR mode IS NULL),
   'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'version',jsonb_build_object('id',rule_id,'revision',rule_revision,'definition',definition||jsonb_build_object('workspaceId',$1::text)),
    'generation',generation,'mode',mode,'decisions',decisions,'evaluated',evaluated,'suppressed',suppressed,'unknown',decisions-evaluated-suppressed,'opened',opened,'recovered',recovered,
    'firstObservedDecisionAt',to_char(first_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lastObservedDecisionAt',to_char(last_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY rule_id COLLATE "C",rule_revision,generation,mode)
    FROM (SELECT * FROM baseline_groups ORDER BY rule_id COLLATE "C",rule_revision,generation,mode LIMIT 1000) g),'[]'::jsonb))`,
  };
}
