import type { ReplayCoverageQuery } from "@bitsentry-escalator/features/contracts";
// SQL identifiers/expressions below are a closed host-owned mapping. Caller values are bound.
const timestamp = (expression: string) =>
  `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const projection = {
  signal: {
    table: "escalator_signal_source",
    receipts: "escalator_signal_event",
    key: "source_id",
    versions: null,
    version: "source_version",
    slot: "observed_at",
    usable: "true",
  },
  probe: {
    table: "escalator_probe",
    receipts: "escalator_probe_result",
    key: "probe_id",
    versions: "escalator_probe_version",
    version: "probe_version",
    slot: "scheduled_at",
    usable: "data->>'outcome' IN ('healthy','failed')",
  },
  metric: {
    table: "escalator_metric_monitor",
    receipts: "escalator_metric_observation",
    key: "monitor_id",
    versions: "escalator_metric_version",
    version: "monitor_version",
    slot: "observed_at",
    usable: "data->'sample'->>'quality'='complete'",
  },
} as const;
/** One statement snapshot for existence, version history, receipt data and completeness.
 * Windowed payload projection avoids loading metric inputIds or HTTP configuration bodies.
 */
export function coverageSql(kind: ReplayCoverageQuery["kind"]): string {
  const row = projection[kind];
  const configs = row.versions
    ? `SELECT version, jsonb_build_object(
    'version',version,'effectiveAt',${timestamp("effective_at")},'recordedAt',${timestamp("recorded_at")},
    'enabled',(data->>'enabled')::boolean,
    'anchorAt',${kind === "metric" ? "'1970-01-01T00:00:00.000Z'::text" : "data->>'updatedAt'"},
    'stepSeconds',(data->>'${kind === "metric" ? "stepSeconds" : "intervalSeconds"}')::integer) AS metadata
    FROM ${row.versions} WHERE workspace_id=$1 AND ${row.key}=$2
      AND (effective_at IS NULL OR effective_at<$4::timestamptz)
    ORDER BY version LIMIT 10001`
    : "SELECT NULL::bigint AS version,NULL::jsonb AS metadata WHERE false";
  return `WITH configurations AS MATERIALIZED (${configs}),
    receipts AS MATERIALIZED (
      SELECT id, observed_at, jsonb_build_object('id',id,'version',${row.version},
        'slotAt',${timestamp(row.slot)},'observedAt',${timestamp("observed_at")},
        'receivedAt',${timestamp("received_at")},'usable',COALESCE(${row.usable},false)) AS metadata
      FROM ${row.receipts} WHERE workspace_id=$1 AND ${row.key}=$2 AND (
        (${row.slot}>=$3::timestamptz AND ${row.slot}<$4::timestamptz)
        ${kind === "probe" ? "OR (scheduled_at IS NULL AND observed_at>=$3::timestamptz AND observed_at<$4::timestamptz)" : ""})
      ORDER BY observed_at,id LIMIT 100001
    ) SELECT jsonb_build_object(
      'workspaceId',$1::text,'kind','${kind}','streamId',$2::text,
      'snapshotAt',${timestamp("statement_timestamp()")},
      'complete',(SELECT count(*)<=10000 FROM configurations) AND (SELECT count(*)<=100000 FROM receipts),
      'configurations',COALESCE((SELECT jsonb_agg(metadata ORDER BY version) FROM
        (SELECT * FROM configurations ORDER BY version LIMIT 10000) c),'[]'::jsonb),
      'receipts',COALESCE((SELECT jsonb_agg(metadata ORDER BY observed_at,id) FROM
        (SELECT * FROM receipts ORDER BY observed_at,id LIMIT 100000) r),'[]'::jsonb)
    ) AS snapshot FROM ${row.table} WHERE workspace_id=$1 AND id=$2`;
}
