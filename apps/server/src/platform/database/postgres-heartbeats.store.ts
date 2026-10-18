import type { PoolClient } from "pg";
import {
  heartbeatSchema,
  heartbeatStateSchema,
  heartbeatReceiptSchema,
  heartbeatGrantSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type { HeartbeatRecordStore } from "@bitsentry-escalator/features/application";
const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
export function postgresHeartbeatStore(
  connection: PoolClient,
  scope: WorkspaceId,
): HeartbeatRecordStore {
  const schemas = {
    probe: heartbeatSchema,
    state: heartbeatStateSchema,
    receipt: heartbeatReceiptSchema,
    grant: heartbeatGrantSchema,
  };
  async function read<K extends keyof typeof schemas>(
    kind: K,
    key: "id" | "probe_id" | "token_hash",
    value: string,
    lock = false,
  ) {
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_heartbeat_${kind} WHERE workspace_id=$1 AND ${key}=$2${lock ? " FOR UPDATE" : ""}`,
      [scope, value],
    );
    return result.rows[0]
      ? schemas[kind].parse({ ...result.rows[0].data, workspaceId: scope })
      : undefined;
  }
  return {
    async get(id, lock) {
      const row = await read("probe", "id", id, lock);
      return row ? heartbeatSchema.parse(row) : undefined;
    },
    async list(page) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_heartbeat_probe WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3",
        [scope, page.after ?? null, page.limit + 1],
      );
      const values = result.rows.map((row) =>
        heartbeatSchema.parse({ ...row.data, workspaceId: scope }),
      );
      return {
        items: values.slice(0, page.limit),
        next: values.length > page.limit ? values[page.limit - 1].id : null,
      };
    },
    async put(value, expected) {
      if (expected === null) {
        const result = await connection.query(
          "INSERT INTO escalator_heartbeat_probe (workspace_id,id,source_id,service_id,environment_id,version,data) VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::jsonb) ON CONFLICT (workspace_id,id) DO NOTHING",
          [
            scope,
            value.id,
            value.sourceId,
            value.serviceId,
            value.environmentId,
            value.version,
            encode(value),
          ],
        );
        return result.rowCount === 1;
      }
      const result = await connection.query(
        "UPDATE escalator_heartbeat_probe SET version=$3::bigint,data=$4::jsonb WHERE workspace_id=$1 AND id=$2 AND version=$5::bigint",
        [scope, value.id, value.version, encode(value), expected],
      );
      return result.rowCount === 1;
    },
    async state(id) {
      const row = await read("state", "probe_id", id);
      return row ? heartbeatStateSchema.parse(row) : undefined;
    },
    async putState(value) {
      await connection.query(
        "INSERT INTO escalator_heartbeat_state (workspace_id,probe_id,deadline_at,deadline_job_id,data) VALUES ($1,$2,$3::timestamptz,$4,$5::jsonb) ON CONFLICT (workspace_id,probe_id) DO UPDATE SET deadline_at=EXCLUDED.deadline_at,deadline_job_id=EXCLUDED.deadline_job_id,data=EXCLUDED.data",
        [
          scope,
          value.probeId,
          value.deadlineAt,
          value.deadlineJobId,
          encode(value),
        ],
      );
    },
    async receipt(id, eventId) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_heartbeat_receipt WHERE workspace_id=$1 AND probe_id=$2 AND event_id=$3",
        [scope, id, eventId],
      );
      return result.rows[0]
        ? heartbeatReceiptSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async insertReceipt(value) {
      await connection.query(
        "INSERT INTO escalator_heartbeat_receipt (workspace_id,id,probe_id,event_id,grant_id,observed_at,accepted_at,data) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb)",
        [
          scope,
          value.id,
          value.probeId,
          value.eventId,
          value.grantId,
          value.observedAt,
          value.acceptedAt,
          encode(value),
        ],
      );
    },
    async grantByHash(hash) {
      const row = await read("grant", "token_hash", hash, true);
      return row ? heartbeatGrantSchema.parse(row) : undefined;
    },
    async grant(id) {
      const row = await read("grant", "id", id, true);
      return row ? heartbeatGrantSchema.parse(row) : undefined;
    },
    async insertGrant(value) {
      await connection.query(
        "INSERT INTO escalator_heartbeat_grant (workspace_id,id,probe_id,token_hash,data) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [scope, value.id, value.probeId, value.tokenHash, encode(value)],
      );
    },
    async revokeGrant(id, now) {
      const result = await connection.query(
        "UPDATE escalator_heartbeat_grant SET data=jsonb_set(data,'{revokedAt}',COALESCE(NULLIF(data->'revokedAt','null'::jsonb),to_jsonb($3::text))) WHERE workspace_id=$1 AND id=$2",
        [scope, id, now],
      );
      return result.rowCount === 1;
    },
  };
}
