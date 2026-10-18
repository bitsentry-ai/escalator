import type { PoolClient } from "pg";
import {
  probeSchema,
  probeResultSchema,
  probeStateSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  probeScheduleSchema,
  type ProbeRecordStore,
  type PageRequest,
} from "@bitsentry-escalator/features/application";
const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
/** All primitives use one scoped surrounding transaction. SQL text choices are fixed literals. */
export function postgresProbeStore(
  connection: PoolClient,
  scope: WorkspaceId,
): ProbeRecordStore {
  const schemas = {
    probe: probeSchema,
    result: probeResultSchema,
    state: probeStateSchema,
    schedule: probeScheduleSchema,
  };
  const tables = {
    probe: "escalator_probe",
    result: "escalator_probe_result",
    state: "escalator_probe_state",
    schedule: "escalator_probe_schedule",
  };
  async function read<K extends keyof typeof schemas>(
    kind: K,
    id: string,
    lock = false,
  ) {
    const key = kind === "probe" || kind === "result" ? "id" : "probe_id";
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${tables[kind]} WHERE workspace_id=$1 AND ${key}=$2${lock ? " FOR UPDATE" : ""}`,
      [scope, id],
    );
    return result.rows[0]
      ? schemas[kind].parse({ ...result.rows[0].data, workspaceId: scope })
      : undefined;
  }
  async function list(
    kind: "probe" | "result",
    page: PageRequest,
    probeId?: string,
  ) {
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${tables[kind]} WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2)${kind === "result" ? " AND probe_id=$4" : ""} ORDER BY id LIMIT $3`,
      kind === "result"
        ? [scope, page.after ?? null, page.limit + 1, probeId]
        : [scope, page.after ?? null, page.limit + 1],
    );
    return result.rows.map((row) => ({ ...row.data, workspaceId: scope }));
  }
  return {
    async get(id, lock = false) {
      const row = await read("probe", id, lock);
      return row ? probeSchema.parse(row) : undefined;
    },
    async list(page) {
      const rows = (await list("probe", page)).map((row) =>
        probeSchema.parse(row),
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
              "INSERT INTO escalator_probe (workspace_id,id,source_id,service_id,environment_id,auth_secret_id,version,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id,id) DO NOTHING",
              [
                scope,
                value.id,
                value.sourceId,
                value.serviceId,
                value.environmentId,
                value.config.authSecretId,
                value.version,
                encode(value),
              ],
            )
          : await connection.query(
              "UPDATE escalator_probe SET auth_secret_id=$3,version=$4,data=$5 WHERE workspace_id=$1 AND id=$2 AND version=$6",
              [
                scope,
                value.id,
                value.config.authSecretId,
                value.version,
                encode(value),
                expected,
              ],
            );
      return result.rowCount === 1;
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
      return row ? probeScheduleSchema.parse(row) : undefined;
    },
    async putSchedule(value) {
      await connection.query(
        "INSERT INTO escalator_probe_schedule (workspace_id,probe_id,job_id,due_at,data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,probe_id) DO UPDATE SET job_id=EXCLUDED.job_id,due_at=EXCLUDED.due_at,data=EXCLUDED.data",
        [scope, value.probeId, value.jobId, value.dueAt, encode(value)],
      );
    },
    async state(id) {
      const row = await read("state", id);
      return row ? probeStateSchema.parse(row) : undefined;
    },
    async putState(value) {
      await connection.query(
        "INSERT INTO escalator_probe_state (workspace_id,probe_id,last_result_id,data) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id,probe_id) DO UPDATE SET last_result_id=EXCLUDED.last_result_id,data=EXCLUDED.data",
        [scope, value.probeId, value.lastResultId, encode(value)],
      );
    },
    async result(id) {
      const row = await read("result", id);
      return row ? probeResultSchema.parse(row) : undefined;
    },
    async results(id, page) {
      const rows = (await list("result", page, id)).map((row) =>
        probeResultSchema.parse(row),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async recordResult(value) {
      await connection.query(
        "INSERT INTO escalator_probe_result (workspace_id,id,probe_id,observed_at,data) VALUES ($1,$2,$3,$4,$5)",
        [scope, value.id, value.probeId, value.observedAt, encode(value)],
      );
    },
  };
}
