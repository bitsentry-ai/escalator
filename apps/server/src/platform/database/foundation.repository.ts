import { postgresWorkWriter } from "../jobs/postgres-work.writer.js";
import type { Pool, QueryResultRow } from "pg";
import {
  workspaceIdSchema,
  workspaceSchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  type WorkspaceId,
  type Workspace,
  type Service,
  type Environment,
  type Responder,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  TransactionGuard,
  protectFoundationTransaction,
  type FoundationRepository,
  type FoundationTransaction,
  type EntityRepository,
  type Page,
  type PageRequest,
  type AuditEvent,
} from "@bitsentry-escalator/features/application";

type Row = Record<string, unknown>;
const timestamp = (value: unknown): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("Invalid PostgreSQL timestamp");
  return value.toISOString();
};
const dates = (row: Row) => ({
  ...row,
  createdAt: timestamp(row.createdAt),
  updatedAt: timestamp(row.updatedAt),
});
const common = ["createdAt", "updatedAt"];
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
// Column lists below are static; identifiers never originate in caller input.
const columns = (keys: readonly string[]) =>
  keys.map((key) => `${snake(key)} AS "${key}"`).join(", ");
const placeholders = (keys: readonly string[]) =>
  keys.map((_, index) => `$${index + 1}`).join(", ");
function pageLimit(page: PageRequest): number {
  if (
    !Number.isInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100 ||
    (page.after !== undefined &&
      (typeof page.after !== "string" || page.after.length > 200))
  ) {
    throw new PersistenceError("invalid_page");
  }
  return page.limit;
}
function pageOf<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  return {
    items: rows.slice(0, limit),
    next: rows.length > limit ? rows[limit - 1].id : null,
  };
}

export class PostgresFoundationRepository implements FoundationRepository {
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    scope: WorkspaceId,
    work: (tx: FoundationTransaction) => Promise<T>,
  ): Promise<T> {
    workspaceIdSchema.parse(scope);
    const connection = await this.pool.connect();
    const guard = new TransactionGuard(normalizePostgresError);
    const query = <R extends QueryResultRow = Row>(
      sql: string,
      values: unknown[] = [],
    ) => {
      guard.assertCommittable();
      return connection.query<R>(sql, values);
    };
    const scoped = (workspaceId: WorkspaceId) => {
      if (workspaceId !== scope) throw new PersistenceError("scope_violation");
    };
    try {
      await connection.query("BEGIN");
      await connection.query(
        "SELECT set_config('app.workspace_id', $1, true)",
        [scope],
      );
      const time = await query("SELECT transaction_timestamp() AS now");
      const entity = <E extends Service | Environment | Responder>(
        table: string,
        keys: readonly string[],
        parse: (row: unknown) => E,
      ): EntityRepository<E> => ({
        get: async (id) => {
          const result = await query(
            `SELECT ${columns(keys)} FROM ${table} WHERE workspace_id = $1 AND id = $2`,
            [scope, id],
          );
          return result.rows[0] ? parse(dates(result.rows[0])) : undefined;
        },
        list: async (page) => {
          const limit = pageLimit(page);
          const result = await query(
            `SELECT ${columns(keys)} FROM ${table} WHERE workspace_id = $1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3`,
            [scope, page.after ?? null, limit + 1],
          );
          return pageOf(
            result.rows.map((row) => parse(dates(row))),
            limit,
          );
        },
        insert: async (input) => {
          scoped(input.workspaceId);
          const value = parse(input) as E & Record<string, unknown>;
          await query(
            `INSERT INTO ${table} (${keys.map(snake).join(", ")}) VALUES (${placeholders(keys)})`,
            keys.map((key) => value[key]),
          );
        },
      });
      const raw: FoundationTransaction = {
        work: postgresWorkWriter(connection, scope),
        workspaceId: scope,
        now: timestamp(time.rows[0].now),
        workspace: {
          get: async () => {
            const result = await query(
              `SELECT ${columns(["id", "name", ...common])} FROM escalator_workspace WHERE id = $1`,
              [scope],
            );
            return result.rows[0]
              ? workspaceSchema.parse(dates(result.rows[0]))
              : undefined;
          },
          insert: async (input: Workspace) => {
            scoped(input.id);
            const value = workspaceSchema.parse(input);
            await query(
              "INSERT INTO escalator_workspace (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)",
              [value.id, value.name, value.createdAt, value.updatedAt],
            );
          },
        },
        services: entity(
          "escalator_service",
          [
            "workspaceId",
            "id",
            "name",
            "key",
            "owningTeam",
            "enabled",
            ...common,
          ],
          (value) => serviceSchema.parse(value),
        ),
        environments: entity(
          "escalator_environment",
          ["workspaceId", "id", "name", "key", "isProduction", ...common],
          (value) => environmentSchema.parse(value),
        ),
        responders: entity(
          "escalator_responder",
          [
            "workspaceId",
            "id",
            "hostUserId",
            "displayName",
            "timeZone",
            "role",
            "enabled",
            ...common,
          ],
          (value) => responderSchema.parse(value),
        ),
        audit: {
          append: async (event) => {
            scoped(event.workspaceId);
            await query(
              "INSERT INTO escalator_audit (workspace_id,id,actor,action,subject_type,subject_id,recorded_at,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                scope,
                event.id,
                JSON.stringify(event.actor),
                event.action,
                event.subjectType,
                event.subjectId,
                event.recordedAt,
                JSON.stringify(event.metadata),
              ],
            );
          },
          list: async (page) => {
            const limit = pageLimit(page);
            const result = await query(
              `SELECT ${columns(["workspaceId", "id", "actor", "action", "subjectType", "subjectId", "recordedAt", "metadata"])} FROM escalator_audit WHERE workspace_id = $1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3`,
              [scope, page.after ?? null, limit + 1],
            );
            return pageOf(
              result.rows.map(
                (row) =>
                  ({
                    ...row,
                    recordedAt: timestamp(row.recordedAt),
                  }) as unknown as AuditEvent,
              ),
              limit,
            );
          },
        },
      };
      const result = await work(protectFoundationTransaction(raw, guard));
      guard.assertCommittable();
      guard.close();
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      guard.close();
      await connection.query("ROLLBACK");
      throw normalizePostgresError(error);
    } finally {
      guard.close();
      connection.release();
    }
  }
}

function normalizePostgresError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "23505") return new PersistenceError("already_exists");
    if (error.code === "23503") return new PersistenceError("not_found");
    if (error.code === "42501") return new PersistenceError("scope_violation");
  }
  return error;
}
