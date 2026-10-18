import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  acknowledgementGrantSchema,
  deliveryAttemptSchema,
  operationalIncidentSchema,
  operationalPageSchema,
  pageStepSchema,
  recipientDeliverySchema,
} from "@bitsentry-escalator/features/contracts";
import type {
  PagingRecordKind,
  PagingRecordMap,
  PagingRecordStore,
} from "@bitsentry-escalator/features/application";

// Static identifiers only: caller input never selects a SQL table or column.
const tables = {
  incidents: {
    table: "escalator_incident",
    fields: ["serviceId", "environmentId"],
    schema: operationalIncidentSchema,
  },
  pages: {
    table: "escalator_page",
    fields: ["incidentId", "revision"],
    schema: operationalPageSchema,
  },
  steps: {
    table: "escalator_page_step",
    fields: ["pageId", "logicalStepId"],
    schema: pageStepSchema,
  },
  deliveries: {
    table: "escalator_delivery",
    fields: ["pageId", "stepId", "recipientId"],
    schema: recipientDeliverySchema,
  },
  attempts: {
    table: "escalator_delivery_attempt",
    fields: ["deliveryId", "attempt"],
    schema: deliveryAttemptSchema,
  },
  grants: {
    table: "escalator_ack_grant",
    fields: ["pageId", "recipientId", "attemptId", "tokenDigest", "expiresAt"],
    schema: acknowledgementGrantSchema,
  },
} as const;
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export function postgresPagingStore(
  connection: PoolClient,
  scope: WorkspaceId,
): PagingRecordStore {
  function parse<K extends PagingRecordKind>(
    kind: K,
    data: unknown,
  ): PagingRecordMap[K] {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Error("Invalid paging row");
    return tables[kind].schema.parse({
      ...data,
      workspaceId: scope,
    }) as PagingRecordMap[K];
  }
  return {
    async get(kind, id, lock = false) {
      const result = await connection.query<{ data: unknown }>(
        `SELECT data FROM ${tables[kind].table} WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [scope, id],
      );
      return result.rows[0] ? parse(kind, result.rows[0].data) : undefined;
    },
    async list(kind, query) {
      const result = await connection.query<{ data: unknown }>(
        `SELECT data FROM ${tables[kind].table} WHERE workspace_id=$1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3`,
        [scope, query.after ?? null, query.limit + 1],
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
      await connection.query(
        `INSERT INTO ${definition.table} (${columns.join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
    },
    async replace(kind, value) {
      const data = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "workspaceId"),
      );
      const values: unknown[] = [scope, value.id, JSON.stringify(data)];
      const revision = kind === "pages" ? ", revision=$4" : "";
      if (kind === "pages")
        values.push((value as PagingRecordMap["pages"]).revision);
      const result = await connection.query(
        `UPDATE ${tables[kind].table} SET data=$3${revision} WHERE workspace_id=$1 AND id=$2`,
        values,
      );
      if (result.rowCount !== 1)
        throw new Error("Locked paging record disappeared");
    },
    async findGrant(tokenDigest) {
      const result = await connection.query<{ data: unknown }>(
        "SELECT data FROM escalator_ack_grant WHERE workspace_id=$1 AND token_digest=$2 AND expires_at > transaction_timestamp()",
        [scope, tokenDigest],
      );
      return result.rows[0] ? parse("grants", result.rows[0].data) : undefined;
    },
  };
}
