import { watchMeasurementFields } from "@bitsentry-escalator/features/application";
const timestamp = (expression: string) =>
  `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Closed identifiers only. All scope, time and source values are query parameters.
const candidates = ["probe", "metric"]
  .map((kind) => {
    const table =
      kind === "probe" ? "escalator_probe" : "escalator_metric_monitor";
    const sourceKind = kind === "probe" ? "probe" : "metrics";
    return `SELECT '${kind}'::text AS kind,m.id,m.source_id FROM ${table} m
      JOIN escalator_signal_source s ON s.workspace_id=m.workspace_id AND s.id=m.source_id
      WHERE m.workspace_id=$1 AND m.service_id=$2 AND m.environment_id=$3
      AND s.service_id=m.service_id AND s.environment_id=m.environment_id
      AND (m.data->>'enabled')::boolean AND (s.data->>'enabled')::boolean
      AND s.data->>'kind'='${sourceKind}'`;
  })
  .join(" UNION ALL ");
export const baselineSourceLocksSql = `SELECT s.id FROM escalator_signal_source s
 WHERE s.workspace_id=$1 AND s.id IN (SELECT source_id FROM (${candidates}) candidates)
 ORDER BY s.id COLLATE "C" LIMIT 129 FOR UPDATE OF s`;
function measurement(kind: "probe" | "metric", column: string) {
  const fields = watchMeasurementFields[kind]
    .map((field) => `'${field}',${column}->'${field}'`)
    .join(",");
  return `encode(sha256(convert_to(jsonb_build_object(${fields})::text,'UTF8')),'hex')`;
}
function stream(kind: "probe" | "metric") {
  const probe = kind === "probe";
  const table = probe ? "escalator_probe" : "escalator_metric_monitor";
  const versions = probe
    ? "escalator_probe_version"
    : "escalator_metric_version";
  const receipts = probe
    ? "escalator_probe_result"
    : "escalator_metric_observation";
  const key = probe ? "probe_id" : "monitor_id";
  const version = probe ? "probe_version" : "monitor_version";
  const slot = probe ? "scheduled_at" : "observed_at";
  const quality = "r.data->'sample'->>'quality'='complete'";
  const reading = probe
    ? "jsonb_build_object('kind','probe','state',r.data->>'outcome')"
    : `jsonb_build_object('kind','metric','quality',CASE WHEN ${quality} THEN 'complete' ELSE 'unusable' END,
      'requests',CASE WHEN ${quality} THEN r.data->'sample'->'requests' ELSE 'null'::jsonb END,
      'errors',CASE WHEN ${quality} THEN r.data->'sample'->'errors' ELSE 'null'::jsonb END)`;
  return `SELECT jsonb_build_object(
    'workspaceId',m.workspace_id,'serviceId',m.service_id,'environmentId',m.environment_id,
    'kind','${kind}','id',m.id,'sourceId',m.source_id,'configurationVersion',m.version,
    'measurementHash',${measurement(kind, "m.data")},
    ${probe ? "'critical',(m.data->>'critical')::boolean,'failureThreshold',(m.data->>'failureThreshold')::integer" : "'rule',m.data->'rule'"}
    ) || history.data AS data,picked.kind,picked.id
  FROM picked JOIN ${table} m ON m.workspace_id=$1 AND m.id=picked.id
  CROSS JOIN LATERAL (
    WITH configurations AS MATERIALIZED (
      SELECT v.version,jsonb_build_object('version',v.version,
       'effectiveAt',${timestamp("v.effective_at")},'recordedAt',${timestamp("v.recorded_at")},
       'enabled',(v.data->>'enabled')::boolean,
       'anchorAt',${probe ? "v.data->>'updatedAt'" : "'1970-01-01T00:00:00.000Z'::text"},
       'stepSeconds',(v.data->>'${probe ? "intervalSeconds" : "stepSeconds"}')::integer,
       'measurementHash',${measurement(kind, "v.data")}) AS data
      FROM ${versions} v WHERE v.workspace_id=$1 AND v.${key}=m.id
       AND (v.effective_at IS NULL OR v.effective_at<$5::timestamptz)
       AND v.version>=COALESCE((SELECT max(old.version) FROM ${versions} old
         WHERE old.workspace_id=$1 AND old.${key}=m.id AND old.effective_at<$4::timestamptz),1)
      ORDER BY v.version LIMIT 129
    ), receipts AS MATERIALIZED (
      SELECT r.id,r.observed_at,jsonb_build_object('id',r.id,'version',r.${version},
        'slotAt',${timestamp(`r.${slot}`)},'observedAt',${timestamp("r.observed_at")},
        'receivedAt',${timestamp("r.received_at")},
        'usable',COALESCE(${probe ? "r.data->>'outcome' IN ('healthy','failed')" : quality},false),
        'reading',${reading}) AS data
      FROM ${receipts} r WHERE r.workspace_id=$1 AND r.${key}=m.id
       AND (r.${slot}>=$4::timestamptz AND r.${slot}<$5::timestamptz
         ${probe ? "OR (r.scheduled_at IS NULL AND r.observed_at>=$4::timestamptz AND r.observed_at<$5::timestamptz)" : ""})
      ORDER BY r.observed_at,r.id COLLATE "C" LIMIT 129
    ) SELECT jsonb_build_object(
      'complete',(SELECT count(*)<=128 FROM configurations) AND (SELECT count(*)<=128 FROM receipts),
      'configurations',COALESCE((SELECT jsonb_agg(data ORDER BY version) FROM
        (SELECT * FROM configurations ORDER BY version LIMIT 128) c),'[]'::jsonb),
      'receipts',COALESCE((SELECT jsonb_agg(data ORDER BY observed_at,id COLLATE "C") FROM
        (SELECT * FROM receipts ORDER BY observed_at,id COLLATE "C" LIMIT 128) r),'[]'::jsonb)
    ) AS data
  ) history WHERE picked.kind='${kind}'`;
}
/** Sources were locked before this statement, so recording/configuration and pruning
 * cannot race the snapshot. A newly created, unlocked source makes inventory incomplete.
 */
export const deploymentBaselineSql = `WITH eligible AS MATERIALIZED (${candidates}),
 picked AS MATERIALIZED (SELECT * FROM eligible WHERE source_id=ANY($6::text[])
   ORDER BY kind COLLATE "C",id COLLATE "C" LIMIT 128),
 streams AS (${stream("probe")} UNION ALL ${stream("metric")})
 SELECT jsonb_build_object('workspaceId',$1::text,'serviceId',$2::text,'environmentId',$3::text,
 'capturedAt',${timestamp("statement_timestamp()")},
 'inventoryComplete',(SELECT count(*)<=128 AND bool_and(source_id=ANY($6::text[])) FROM eligible) IS NOT FALSE,
 'streams',COALESCE((SELECT jsonb_agg(data ORDER BY kind COLLATE "C",id COLLATE "C") FROM streams),'[]'::jsonb)) AS snapshot`;
