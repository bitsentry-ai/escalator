import type { PoolClient } from "pg";
import {
  signalSourceSchema,
  signalTokenSchema,
  signalEventSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type { SignalRecordStore } from "@bitsentry-escalator/features/application";

const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
export function postgresSignalStore(
  connection: PoolClient,
  scope: WorkspaceId,
): SignalRecordStore {
  const schemas = {
    source: signalSourceSchema,
    token: signalTokenSchema,
    event: signalEventSchema,
  };
  // Identifiers are a closed internal set; request values are always bound.
  async function read<K extends keyof typeof schemas>(
    kind: K,
    predicate: "id" | "token_hash",
    value: string,
    lock = false,
  ) {
    const result = await connection.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM escalator_signal_${kind} WHERE workspace_id=$1 AND ${predicate}=$2${lock ? " FOR UPDATE" : ""}`,
      [scope, value],
    );
    return result.rows[0]
      ? schemas[kind].parse({ ...result.rows[0].data, workspaceId: scope })
      : undefined;
  }
  return {
    async currentTime() {
      const result = await connection.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      return result.rows[0].now.toISOString();
    },
    async getSource(id) {
      const row = await read("source", "id", id, true);
      return row ? signalSourceSchema.parse(row) : undefined;
    },
    async listSources(page) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_signal_source WHERE workspace_id=$1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3",
        [scope, page.after ?? null, page.limit + 1],
      );
      const rows = result.rows.map(({ data }) =>
        signalSourceSchema.parse({ ...data, workspaceId: scope }),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async insertSource(value) {
      await connection.query(
        "INSERT INTO escalator_signal_source (workspace_id,id,service_id,environment_id,auth_secret_id,version,data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          scope,
          value.id,
          value.serviceId,
          value.environmentId,
          value.authSecretId,
          value.version,
          encode(value),
        ],
      );
    },
    async replaceSource(value, expected) {
      const result = await connection.query(
        "UPDATE escalator_signal_source SET data=$3,version=$4,auth_secret_id=$5 WHERE workspace_id=$1 AND id=$2 AND version=$6",
        [
          scope,
          value.id,
          encode(value),
          value.version,
          value.authSecretId,
          expected,
        ],
      );
      return result.rowCount === 1;
    },
    async hasSecret(id) {
      const result = await connection.query(
        "SELECT 1 FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL AND purpose='provider' FOR SHARE",
        [scope, id],
      );
      return result.rowCount === 1;
    },
    async listTokens(sourceId, page) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_signal_token WHERE workspace_id=$1 AND source_id=$2 AND ($3::text IS NULL OR id > $3) ORDER BY id LIMIT $4",
        [scope, sourceId, page.after ?? null, page.limit + 1],
      );
      const rows = result.rows.map(({ data }) =>
        signalTokenSchema.parse({ ...data, workspaceId: scope }),
      );
      return {
        items: rows.slice(0, page.limit),
        next: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    },
    async getTokenByHash(hash) {
      const row = await read("token", "token_hash", hash);
      return row ? signalTokenSchema.parse(row) : undefined;
    },
    async getToken(id) {
      const row = await read("token", "id", id);
      return row ? signalTokenSchema.parse(row) : undefined;
    },
    async insertToken(value) {
      await connection.query(
        "INSERT INTO escalator_signal_token (workspace_id,id,source_id,token_hash,data) VALUES ($1,$2,$3,$4,$5)",
        [scope, value.id, value.sourceId, value.tokenHash, encode(value)],
      );
    },
    async revokeToken(id, at) {
      const result = await connection.query(
        "UPDATE escalator_signal_token SET data=jsonb_set(data,'{revokedAt}',to_jsonb($3::text)) WHERE workspace_id=$1 AND id=$2 AND data->>'revokedAt' IS NULL",
        [scope, id, at],
      );
      if (result.rowCount === 1) return true;
      const existing = await connection.query(
        "SELECT 1 FROM escalator_signal_token WHERE workspace_id=$1 AND id=$2",
        [scope, id],
      );
      return existing.rowCount === 1;
    },
    async getSignal(id) {
      const row = await read("event", "id", id);
      return row ? signalEventSchema.parse(row) : undefined;
    },
    async insertSignal(value) {
      const result = await connection.query(
        "INSERT INTO escalator_signal_event (workspace_id,id,source_id,event_id,observed_at,received_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,source_id,event_id) DO NOTHING",
        [
          scope,
          value.id,
          value.sourceId,
          value.eventId,
          value.observedAt,
          value.receivedAt,
          encode(value),
        ],
      );
      return result.rowCount === 1 ? "inserted" : "duplicate";
    },
  };
}
