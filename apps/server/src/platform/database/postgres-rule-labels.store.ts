import type { PoolClient } from "pg";
import {
  incidentLabelSchema,
  operationalIncidentSchema,
  serviceIdSchema,
  environmentIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type { IncidentLabelRecordStore } from "@bitsentry-escalator/features/application";

/** Bound values only; table identifiers come from a closed internal set. */
export function postgresRuleLabelStore(
  db: PoolClient,
  scope: WorkspaceId,
): IncidentLabelRecordStore {
  const decode = (data: Record<string, unknown>) =>
    incidentLabelSchema.parse({ ...data, workspaceId: scope });
  const tables = {
    metric: "escalator_metric_monitor",
    probe: "escalator_probe",
    signal: "escalator_signal_source",
  } as const;
  return {
    async currentTime() {
      const result = await db.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      return result.rows[0].now.toISOString();
    },
    async lockStream(stream) {
      const result = await db.query<{
        id: string;
        service_id: string;
        environment_id: string;
      }>(
        `SELECT id,service_id,environment_id FROM ${tables[stream.kind]} WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
        [scope, stream.id],
      );
      const row = result.rows[0];
      return row
        ? {
            workspaceId: scope,
            kind: stream.kind,
            id: row.id,
            serviceId: serviceIdSchema.parse(row.service_id),
            environmentId: environmentIdSchema.parse(row.environment_id),
          }
        : undefined;
    },
    async incident(id) {
      const result = await db.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_incident WHERE workspace_id=$1 AND id=$2",
        [scope, id],
      );
      return result.rows[0]
        ? operationalIncidentSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async get(id, lock) {
      const result = await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM escalator_incident_label WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [scope, id],
      );
      return result.rows[0] ? decode(result.rows[0].data) : undefined;
    },
    async list(selection, page) {
      const result = await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM escalator_incident_label WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3
         AND ($4::text IS NULL OR stream_kind=$4) AND ($5::text IS NULL OR stream_id=$5)
         AND ($6::text IS NULL OR status=$6) AND ($7::text IS NULL OR incident_id=$7) AND ($8::text IS NULL OR id>$8) ORDER BY id LIMIT $9`,
        [
          scope,
          selection.serviceId,
          selection.environmentId,
          selection.stream?.kind ?? null,
          selection.stream?.id ?? null,
          selection.status ?? null,
          selection.incidentId ?? null,
          page.after ?? null,
          page.limit + 1,
        ],
      );
      const rows = result.rows.map((row) => decode(row.data));
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async put(value, expected) {
      const { workspaceId, ...data } = value;
      if (workspaceId !== scope) throw new Error("Label scope mismatch");
      const payload = JSON.stringify(data);
      const result =
        expected === null
          ? await db.query(
              `INSERT INTO escalator_incident_label(workspace_id,id,service_id,environment_id,stream_kind,stream_id,incident_id,revision,status,created_by,reviewed_by,data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING`,
              [
                scope,
                value.id,
                value.serviceId,
                value.environmentId,
                value.stream.kind,
                value.stream.id,
                value.incidentId,
                BigInt(value.revision),
                value.status,
                value.createdBy,
                value.reviewedBy,
                payload,
              ],
            )
          : await db.query(
              `UPDATE escalator_incident_label SET revision=$3::bigint,status=$4,reviewed_by=$5,data=$6::jsonb WHERE workspace_id=$1 AND id=$2 AND revision=$7::bigint AND status='draft'`,
              [
                scope,
                value.id,
                BigInt(value.revision),
                value.status,
                value.reviewedBy,
                payload,
                BigInt(expected),
              ],
            );
      return result.rowCount === 1;
    },
  };
}
