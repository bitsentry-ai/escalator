import type { PoolClient } from "pg";
import {
  metricMonitorSchema,
  metricScheduleSchema,
  metricObservationSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type { MetricsRecordStore } from "@bitsentry-escalator/features/application";
const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
export function postgresMetricsStore(
  connection: PoolClient,
  scope: WorkspaceId,
): MetricsRecordStore {
  const schemas = {
    monitor: metricMonitorSchema,
    schedule: metricScheduleSchema,
    observation: metricObservationSchema,
  };
  async function read<K extends keyof typeof schemas>(
    kind: K,
    id: string,
    lock = false,
  ) {
    const key = kind === "schedule" ? "monitor_id" : "id";
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_metric_${kind} WHERE workspace_id=$1 AND ${key}=$2${lock ? " FOR UPDATE" : ""}`,
      [scope, id],
    );
    return result.rows[0]
      ? schemas[kind].parse({ ...result.rows[0].data, workspaceId: scope })
      : undefined;
  }
  return {
    async lockCapacity() {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
        [JSON.stringify(["escalator-metric-capacity", scope])],
      );
    },
    async get(id, lock) {
      const row = await read("monitor", id, lock);
      return row ? metricMonitorSchema.parse(row) : undefined;
    },
    async list(page) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_metric_monitor WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3",
        [scope, page.after ?? null, page.limit + 1],
      );
      const rows = result.rows.map((row) =>
        metricMonitorSchema.parse({ ...row.data, workspaceId: scope }),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async put(value, expected) {
      const result =
        expected === null
          ? await connection.query(
              "INSERT INTO escalator_metric_monitor(workspace_id,id,source_id,service_id,environment_id,auth_secret_id,version,data) VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING",
              [
                scope,
                value.id,
                value.sourceId,
                value.serviceId,
                value.environmentId,
                value.query.connection.authSecretId,
                value.version,
                encode(value),
              ],
            )
          : await connection.query(
              "UPDATE escalator_metric_monitor SET version=$3::bigint,auth_secret_id=$4,data=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND version=$6::bigint",
              [
                scope,
                value.id,
                value.version,
                value.query.connection.authSecretId,
                encode(value),
                expected,
              ],
            );
      if (result.rowCount !== 1) return false;
      await connection.query(
        "INSERT INTO escalator_metric_version(workspace_id,monitor_id,version,data) VALUES($1,$2,$3::bigint,$4::jsonb)",
        [scope, value.id, value.version, encode(value)],
      );
      return true;
    },
    async version(id, version) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_metric_version WHERE workspace_id=$1 AND monitor_id=$2 AND version=$3::bigint",
        [scope, id, version],
      );
      return result.rows[0]
        ? metricMonitorSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async hasSecret(id) {
      const result = await connection.query(
        "SELECT id FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND purpose='provider' AND disabled_at IS NULL FOR SHARE",
        [scope, id],
      );
      return result.rows.length === 1;
    },
    async schedule(id) {
      const row = await read("schedule", id);
      return row ? metricScheduleSchema.parse(row) : undefined;
    },
    async putSchedule(value) {
      await connection.query(
        "INSERT INTO escalator_metric_schedule(workspace_id,monitor_id,monitor_version,job_id,due_at,last_observation_id,data) VALUES($1,$2,$3::bigint,$4,$5::timestamptz,$6,$7::jsonb) ON CONFLICT(workspace_id,monitor_id) DO UPDATE SET monitor_version=EXCLUDED.monitor_version,job_id=EXCLUDED.job_id,due_at=EXCLUDED.due_at,last_observation_id=EXCLUDED.last_observation_id,data=EXCLUDED.data",
        [
          scope,
          value.monitorId,
          value.monitorVersion,
          value.jobId,
          value.dueAt,
          value.lastObservationId,
          encode(value),
        ],
      );
    },
    async observation(id) {
      const row = await read("observation", id);
      return row ? metricObservationSchema.parse(row) : undefined;
    },
    async history(id, page) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_metric_observation WHERE workspace_id=$1 AND monitor_id=$2 AND ($3::text IS NULL OR (received_at,id)<(SELECT received_at,id FROM escalator_metric_observation WHERE workspace_id=$1 AND monitor_id=$2 AND id=$3)) ORDER BY received_at DESC,id DESC LIMIT $4",
        [scope, id, page.after ?? null, page.limit + 1],
      );
      const rows = result.rows.map((row) =>
        metricObservationSchema.parse({ ...row.data, workspaceId: scope }),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async window(query) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT DISTINCT ON(observed_at) data FROM escalator_metric_observation WHERE workspace_id=$1 AND monitor_id=$2 AND monitor_version=$3::bigint AND observed_at BETWEEN $4::timestamptz AND $5::timestamptz AND received_at<=$6::timestamptz ORDER BY observed_at,received_at DESC,id DESC LIMIT $7",
        [
          scope,
          query.monitorId,
          query.monitorVersion,
          query.startAt,
          query.endAt,
          query.visibleAt,
          query.limit,
        ],
      );
      return result.rows.map((row) =>
        metricObservationSchema.parse({ ...row.data, workspaceId: scope }),
      );
    },
    async recordObservation(value) {
      await connection.query(
        "INSERT INTO escalator_metric_observation(workspace_id,id,monitor_id,monitor_version,observed_at,received_at,data) VALUES($1,$2,$3,$4::bigint,$5::timestamptz,$6::timestamptz,$7::jsonb)",
        [
          scope,
          value.id,
          value.monitorId,
          value.monitorVersion,
          value.observedAt,
          value.receivedAt,
          encode(value),
        ],
      );
    },
  };
}
