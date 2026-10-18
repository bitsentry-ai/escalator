import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  scheduleSchema,
  configuredPolicySchema,
  configuredContactSchema,
  availabilitySchema,
  schedulePreviewSchema,
} from "@bitsentry-escalator/features/contracts";
import type {
  ConfigurationKind,
  ConfigurationRecordMap,
  ConfigurationRecordStore,
} from "@bitsentry-escalator/features/application";

// Static identifiers only: caller input never selects a SQL table or column.
const tables = {
  schedules: {
    table: "escalator_schedule",
    fields: ["serviceId", "version"],
    schema: scheduleSchema,
  },
  policies: {
    table: "escalator_policy",
    fields: [
      "serviceId",
      "version",
      "primaryScheduleId",
      "peerScheduleId",
      "primaryPreviewId",
      "peerPreviewId",
    ],
    schema: configuredPolicySchema,
  },
  contacts: {
    table: "escalator_contact",
    fields: ["responderId", "secretId", "version"],
    schema: configuredContactSchema,
  },
  availability: {
    table: "escalator_availability",
    fields: ["version"],
    schema: availabilitySchema,
  },
  previews: {
    table: "escalator_schedule_preview",
    fields: ["scheduleId", "serviceId", "scheduleVersion"],
    schema: schedulePreviewSchema,
  },
} as const;
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export function postgresConfigurationStore(
  connection: PoolClient,
  scope: WorkspaceId,
): ConfigurationRecordStore {
  function parse<K extends ConfigurationKind>(
    kind: K,
    data: unknown,
  ): ConfigurationRecordMap[K] {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Error("Invalid configuration row");
    return tables[kind].schema.parse({
      ...data,
      workspaceId: scope,
    }) as ConfigurationRecordMap[K];
  }
  return {
    async get(kind, id, lock = false) {
      const result = await connection.query<{ data: unknown }>(
        `SELECT data FROM ${tables[kind].table} WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [scope, id],
      );
      return result.rows[0] ? parse(kind, result.rows[0].data) : undefined;
    },
    async list(kind, query, parentId) {
      const parentColumn = kind === "previews" ? "schedule_id" : "responder_id";
      if (parentId !== undefined && !["previews", "contacts"].includes(kind))
        throw new Error("Unsupported paging parent filter");
      const filter =
        parentId === undefined ? "" : " AND " + parentColumn + "=$4";
      const result = await connection.query<{ data: unknown }>(
        `SELECT data FROM ${tables[kind].table} WHERE workspace_id=$1 AND ($2::text IS NULL OR id > $2)${filter} ORDER BY id LIMIT $3`,
        [
          scope,
          query.after ?? null,
          query.limit + 1,
          ...(parentId === undefined ? [] : [parentId]),
        ],
      );
      const rows = result.rows.map((row) => parse(kind, row.data));
      return {
        items: rows.slice(0, query.limit),
        next: rows.length > query.limit ? rows[query.limit - 1].id : null,
      };
    },
    async insert(kind, value) {
      const data = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "workspaceId"),
      );
      const definition = tables[kind];
      const record: Record<string, unknown> = value;
      const columns = [
        "workspace_id",
        "id",
        "data",
        ...definition.fields.map(snake),
      ];
      const values = [
        scope,
        value.id,
        JSON.stringify(data),
        ...definition.fields.map((field) => record[field]),
      ];
      const placeholders = values.map((_, i) => `$${i + 1}`).join(",");
      await connection.query(
        `INSERT INTO ${definition.table} (${columns.join(",")}) VALUES (${placeholders})`,
        values,
      );
    },
    async replace(kind, value) {
      const data = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "workspaceId"),
      );
      const record: Record<string, unknown> = value;
      const definition = tables[kind];
      const values = [
        scope,
        value.id,
        JSON.stringify(data),
        ...definition.fields.map((field) => record[field]),
      ];
      const sets = definition.fields.map(
        (field, index) => `${snake(field)}=$${index + 4}`,
      );
      const result = await connection.query(
        `UPDATE ${definition.table} SET data=$3,${sets.join(",")} WHERE workspace_id=$1 AND id=$2 AND version=$${values.length + 1}`,
        [...values, value.version - 1],
      );
      if (result.rowCount !== 1)
        throw new Error("Configuration replacement conflict");
    },
    async routingContacts(id) {
      const result = await connection.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM escalator_contact WHERE workspace_id=$1 AND responder_id=$2 ORDER BY id",
        [scope, id],
      );
      return result.rows.map((row) => ({ ...row.data, workspaceId: scope }));
    },
    async contactCount(id) {
      await connection.query(
        "SELECT id FROM escalator_responder WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [scope, id],
      );
      const result = await connection.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM escalator_contact WHERE workspace_id=$1 AND responder_id=$2",
        [scope, id],
      );
      return Number(result.rows[0].count);
    },
    async secretExists(id, channel) {
      const result = await connection.query(
        "SELECT 1 FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL AND purpose='provider' AND channel=$3 FOR SHARE",
        [scope, id, channel],
      );
      return result.rowCount === 1;
    },
  };
}
