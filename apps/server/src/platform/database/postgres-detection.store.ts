import type { PoolClient } from "pg";
import {
  alertGroupSchema,
  alertStateSchema,
  processedSignalSchema,
  serviceEnvironmentSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  DetectionRecordStore,
  PageRequest,
} from "@bitsentry-escalator/features/application";
const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
/** Every primitive uses the caller's scoped transaction; no pool access or plaintext credentials. */
export function postgresDetectionStore(
  connection: PoolClient,
  scope: WorkspaceId,
): DetectionRecordStore {
  const schemas = {
    binding: serviceEnvironmentSchema,
    group: alertGroupSchema,
    alert: alertStateSchema,
    processed: processedSignalSchema,
  };
  async function read<K extends keyof typeof schemas>(kind: K, id: string) {
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_detection_${kind} WHERE workspace_id=$1 AND id=$2`,
      [scope, id],
    );
    return result.rows[0]
      ? schemas[kind].parse({ ...result.rows[0].data, workspaceId: scope })
      : undefined;
  }
  async function list(
    kind: "binding" | "alert",
    page: PageRequest,
    incidentId?: string,
  ) {
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_detection_${kind} WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2)${kind === "alert" ? " AND incident_id=$4" : ""} ORDER BY id LIMIT $3`,
      kind === "alert"
        ? [scope, page.after ?? null, page.limit + 1, incidentId]
        : [scope, page.after ?? null, page.limit + 1],
    );
    return result.rows.map((row) => ({ ...row.data, workspaceId: scope }));
  }
  return {
    async binding(serviceId, environmentId, lock = false) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM escalator_detection_binding WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3${lock ? " FOR UPDATE" : ""}`,
        [scope, serviceId, environmentId],
      );
      return result.rows[0]
        ? serviceEnvironmentSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async bindings(page) {
      const rows = (await list("binding", page)).map((row) =>
        serviceEnvironmentSchema.parse(row),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async putBinding(value, expected) {
      const result =
        expected === null
          ? await connection.query(
              "INSERT INTO escalator_detection_binding (workspace_id,id,service_id,environment_id,policy_id,version,data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,service_id,environment_id) DO NOTHING",
              [
                scope,
                value.id,
                value.serviceId,
                value.environmentId,
                value.policyId,
                value.version,
                encode(value),
              ],
            )
          : await connection.query(
              "UPDATE escalator_detection_binding SET policy_id=$3,version=$4,data=$5 WHERE workspace_id=$1 AND id=$2 AND version=$6",
              [
                scope,
                value.id,
                value.policyId,
                value.version,
                encode(value),
                expected,
              ],
            );
      return result.rowCount === 1;
    },
    async lockGroup(key) {
      // Row locks alone cannot serialize two transactions that both see no group.
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["escalator-detection", scope, key])],
      );
      const row = await read("group", key);
      return row ? alertGroupSchema.parse(row) : undefined;
    },
    async putGroup(value, expected) {
      const result =
        expected === null
          ? await connection.query(
              "INSERT INTO escalator_detection_group (workspace_id,id,service_id,environment_id,incident_id,revision,data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,id) DO NOTHING",
              [
                scope,
                value.id,
                value.serviceId,
                value.environmentId,
                value.incidentId,
                value.revision,
                encode(value),
              ],
            )
          : await connection.query(
              "UPDATE escalator_detection_group SET incident_id=$3,revision=$4,data=$5 WHERE workspace_id=$1 AND id=$2 AND revision=$6",
              [
                scope,
                value.id,
                value.incidentId,
                value.revision,
                encode(value),
                expected,
              ],
            );
      return result.rowCount === 1;
    },
    async alert(id) {
      const row = await read("alert", id);
      return row ? alertStateSchema.parse(row) : undefined;
    },
    async putAlert(value) {
      await connection.query(
        "INSERT INTO escalator_detection_alert (workspace_id,id,source_id,group_key,incident_id,last_signal_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,id) DO UPDATE SET group_key=EXCLUDED.group_key,incident_id=EXCLUDED.incident_id,last_signal_id=EXCLUDED.last_signal_id,data=EXCLUDED.data",
        [
          scope,
          value.id,
          value.sourceId,
          value.groupKey,
          value.incidentId,
          value.lastSignalId,
          encode(value),
        ],
      );
    },
    async forIncident(id, page) {
      const rows = (await list("alert", page, id)).map((row) =>
        alertStateSchema.parse(row),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async processed(id) {
      const row = await read("processed", id);
      return row ? processedSignalSchema.parse(row) : undefined;
    },
    async recordProcessed(value) {
      await connection.query(
        "INSERT INTO escalator_detection_processed (workspace_id,id,source_id,incident_id,recorded_at,data) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          scope,
          value.id,
          value.sourceId,
          value.incidentId,
          value.recordedAt,
          encode(value),
        ],
      );
    },
  };
}
