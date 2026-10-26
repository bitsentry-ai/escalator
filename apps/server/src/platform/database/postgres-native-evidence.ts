import type {
  InvestigationScope,
  EvidenceQuery,
} from "@bitsentry-escalator/features/contracts";
import { normalizeNativeEvidence } from "@bitsentry-escalator/features/investigation";
export interface NativeEvidenceSql {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
}
interface Row {
  record: Record<string, unknown>;
  service_id: string;
  environment_id: string;
  received_at?: Date;
  event?: string;
}
/** Called only inside the repository's live-claim/configuration fence. Fixed SQL,
 * bounded rows, historical placement, no arbitrary provider query or secret read. */
export async function readNativeEvidence(
  db: NativeEvidenceSql,
  scope: InvestigationScope,
  query: EvidenceQuery,
  collectedAt: string,
  maxBytes: number,
) {
  const unavailable = (
    reason: "not_configured" | "not_found" | "invalid_response",
  ) => ({ status: "unavailable" as const, unavailable: { query, reason } });
  const parameters = [
    scope.workspaceId,
    query.sourceId,
    scope.serviceId,
    scope.environmentId,
    query.window.from,
    query.window.to,
    collectedAt,
    query.limit + 1,
  ];
  let sql: string;
  switch (query.kind) {
    case "probe":
      sql = `SELECT r.data AS record,v.data->>'serviceId' AS service_id,v.data->>'environmentId' AS environment_id,r.received_at
 FROM escalator_probe_result r JOIN escalator_probe_version v ON v.workspace_id=r.workspace_id AND v.probe_id=r.probe_id AND v.version=r.probe_version
 WHERE r.workspace_id=$1 AND r.probe_id=$2 AND v.data->>'serviceId'=$3 AND v.data->>'environmentId'=$4
 AND r.observed_at BETWEEN $5::timestamptz AND $6::timestamptz AND r.received_at<=$7::timestamptz
 ORDER BY r.observed_at DESC,r.id LIMIT $8`;
      break;
    case "metric":
      sql = `SELECT r.data AS record,v.data->>'serviceId' AS service_id,v.data->>'environmentId' AS environment_id
 FROM escalator_metric_observation r JOIN escalator_metric_version v ON v.workspace_id=r.workspace_id AND v.monitor_id=r.monitor_id AND v.version=r.monitor_version
 WHERE r.workspace_id=$1 AND r.monitor_id=$2 AND v.data->>'serviceId'=$3 AND v.data->>'environmentId'=$4
 AND r.observed_at BETWEEN $5::timestamptz AND $6::timestamptz AND r.received_at<=$7::timestamptz
 ORDER BY r.observed_at DESC,r.id LIMIT $8`;
      break;
    case "alert":
      sql = `SELECT jsonb_set(r.data,'{evidence,attributes}','[]'::jsonb) AS record,r.data->>'serviceId' AS service_id,r.data->>'environmentId' AS environment_id
 FROM escalator_signal_event r WHERE r.workspace_id=$1 AND r.source_id=$2 AND r.data->>'serviceId'=$3 AND r.data->>'environmentId'=$4
 AND r.observed_at BETWEEN $5::timestamptz AND $6::timestamptz AND r.received_at<=$7::timestamptz
 ORDER BY r.observed_at DESC,r.id LIMIT $8`;
      break;
    case "deployment":
      sql = `SELECT r.data AS record,r.service_id,r.environment_id,e.event
 FROM escalator_deployment r CROSS JOIN LATERAL (VALUES
 ('start',(r.data->>'startedAt')::timestamptz,(r.data->>'acceptedAt')::timestamptz),
 ('finish',(r.data->'finish'->>'occurredAt')::timestamptz,(r.data->'finish'->>'receivedAt')::timestamptz),
 ('timeout',(r.data->>'timedOutAt')::timestamptz,(r.data->>'timedOutAt')::timestamptz)) e(event,observed_at,received_at)
 WHERE r.workspace_id=$1 AND r.target_id=$2 AND r.service_id=$3 AND r.environment_id=$4
 AND e.observed_at BETWEEN $5::timestamptz AND $6::timestamptz AND e.received_at<=$7::timestamptz
 ORDER BY e.observed_at DESC,r.id,e.event LIMIT $8`;
      break;
    default:
      return unavailable("not_configured");
  }
  const rows = (await db.query<Row>(sql, parameters)).rows;
  // Bound materialization even if a test/integration adapter violates the SQL contract.
  if (rows.length > query.limit + 1) return unavailable("invalid_response");
  const mapped = rows.map((row) => {
    const record = { ...row.record, workspaceId: scope.workspaceId };
    switch (query.kind) {
      case "probe":
        return {
          kind: query.kind,
          record,
          serviceId: row.service_id,
          environmentId: row.environment_id,
          receivedAt: row.received_at?.toISOString(),
        };
      case "metric":
        return {
          kind: query.kind,
          record,
          serviceId: row.service_id,
          environmentId: row.environment_id,
        };
      case "alert":
        return { kind: query.kind, record };
      case "deployment":
        return {
          kind: query.kind,
          record,
          targetId: query.sourceId,
          event: row.event,
        };
      default:
        // Unreachable: the query switch above returned for every other kind.
        throw new Error(`Unsupported evidence kind ${query.kind}`);
    }
  });
  // Legacy rows without receipt/version metadata are excluded; explicitly mark gaps.
  let incomplete = false;
  if (query.kind === "probe") {
    const gaps = await db.query<{ missing: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM escalator_probe_result r
 JOIN escalator_probe p ON p.workspace_id=r.workspace_id AND p.id=r.probe_id
 WHERE r.workspace_id=$1 AND r.probe_id=$2 AND p.service_id=$3 AND p.environment_id=$4
 AND r.observed_at BETWEEN $5::timestamptz AND $6::timestamptz AND (r.received_at IS NULL OR r.probe_version IS NULL)) AS missing`,
      parameters.slice(0, 6),
    );
    incomplete = gaps.rows[0]?.missing !== false;
  }
  return normalizeNativeEvidence(
    scope,
    query,
    mapped,
    collectedAt,
    maxBytes,
    incomplete,
  );
}
