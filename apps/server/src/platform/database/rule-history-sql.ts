import type { RuleHistoryQuery } from "@bitsentry-escalator/features/contracts";
import { watchMeasurementFields } from "@bitsentry-escalator/features/application";
// Closed host identifiers; every caller-supplied value is bound separately.
// Untyped parameters take the type of their first cast, so time bounds are always
// read as text before timestamptz and echo back exactly as bound.
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const tables = {
  probe: {
    table: "escalator_probe",
    versions: "escalator_probe_version",
    receipts: "escalator_probe_result",
    key: "probe_id",
    version: "probe_version",
    slot: "scheduled_at",
  },
  metric: {
    table: "escalator_metric_monitor",
    versions: "escalator_metric_version",
    receipts: "escalator_metric_observation",
    key: "monitor_id",
    version: "monitor_version",
    slot: "observed_at",
  },
  signal: {
    table: "escalator_signal_source",
    versions: null,
    receipts: "escalator_signal_event",
    key: "source_id",
    version: "source_version",
    slot: "observed_at",
  },
} as const;
/** A bounded scalar snapshot for one decision; never loads provider bodies or credentials.
 * PostgreSQL applies receipt cutoffs before converting timestamps to JSON so sub-ms
 * arrivals cannot become evidence for an earlier millisecond decision.
 */
export function ruleHistorySql(kind: RuleHistoryQuery["kind"]): string {
  const row = tables[kind];
  const fields = kind === "signal" ? [] : watchMeasurementFields[kind];
  const hash = `encode(sha256(convert_to(jsonb_build_object(${fields.map((field) => `'${field}',data->'${field}'`).join(",")})::text,'UTF8')),'hex')`;
  const configurations = row.versions
    ? `SELECT version,jsonb_build_object(
    'version',version,'effectiveAt',${timestamp("effective_at")},
    'recordedAt',CASE WHEN recorded_at<=$7::text::timestamptz AND data->>'serviceId'=$3 AND data->>'environmentId'=$4 THEN ${timestamp("recorded_at")} ELSE NULL END,
    'enabled',(data->>'enabled')::boolean,'measurementHash',${hash},
    'anchorAt',${kind === "metric" ? "'1970-01-01T00:00:00.000Z'::text" : "data->>'updatedAt'"},
    'stepSeconds',(data->>'${kind === "metric" ? "stepSeconds" : "intervalSeconds"}')::integer) AS record
    FROM ${row.versions} WHERE workspace_id=$1 AND ${row.key}=$2
    AND (effective_at IS NULL OR effective_at<=$6::text::timestamptz)
    ORDER BY version LIMIT 10001`
    : "SELECT NULL::bigint AS version,NULL::jsonb AS record WHERE false";
  const quality = "r.data->'sample'->>'quality'='complete'";
  const reading =
    kind === "signal"
      ? ""
      : kind === "probe"
        ? `,'slotAt',${timestamp("r.scheduled_at")},'usable',COALESCE(r.data->>'outcome' IN ('healthy','failed'),false),
     'success',CASE WHEN r.data->>'outcome' IN ('healthy','failed') THEN r.data->>'outcome'='healthy' ELSE NULL END,
     'durationMs',r.data->'durationMs'`
        : `,'slotAt',${timestamp("r.observed_at")},'usable',COALESCE(${quality},false),
     'requests',CASE WHEN ${quality} THEN r.data->'sample'->'requests' ELSE 'null'::jsonb END,
     'errors',CASE WHEN ${quality} THEN r.data->'sample'->'errors' ELSE 'null'::jsonb END`;
  return `WITH configurations AS MATERIALIZED (${configurations}),
  receipts AS MATERIALIZED (
    SELECT r.id,r.observed_at,jsonb_build_object('version',r.${row.version},'sample',jsonb_build_object(
      'workspaceId',$1::text,'serviceId',$3::text,'environmentId',$4::text,'kind','${kind}',
      'streamId',$2::text,'id',r.id,'observedAt',${timestamp("r.observed_at")},
      'receivedAt',${timestamp("r.received_at")}${reading})) AS record
    FROM ${row.receipts} r WHERE r.workspace_id=$1 AND r.${row.key}=$2
      AND ((r.${row.slot}>$5::text::timestamptz AND r.${row.slot}<=$6::text::timestamptz)
        ${kind === "probe" ? "OR (r.scheduled_at IS NULL AND r.observed_at>$5::text::timestamptz AND r.observed_at<=$6::text::timestamptz)" : ""})
      AND r.observed_at<=$7::text::timestamptz AND (r.received_at IS NULL OR r.received_at<=$7::text::timestamptz)
    ORDER BY r.observed_at,r.id COLLATE "C" LIMIT 100001
  ) SELECT jsonb_build_object('workspaceId',$1::text,'serviceId',$3::text,'environmentId',$4::text,
    'kind','${kind}','streamId',$2::text,'snapshotAt',${timestamp("statement_timestamp()")},
    'startAt',$5::text,'endAt',$6::text,'visibleAt',$7::text,
    'complete',(SELECT count(*)<=10000 FROM configurations) AND (SELECT count(*)<=100000 FROM receipts),
    'configurations',COALESCE((SELECT jsonb_agg(record ORDER BY version) FROM
      (SELECT * FROM configurations ORDER BY version LIMIT 10000) c),'[]'::jsonb),
    'receipts',COALESCE((SELECT jsonb_agg(record ORDER BY observed_at,id COLLATE "C") FROM
      (SELECT * FROM receipts ORDER BY observed_at,id COLLATE "C" LIMIT 100000) r),'[]'::jsonb)
  ) AS snapshot FROM ${row.table} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4`;
}
