import type { PoolClient } from "pg";
import {
  ruleCatalogViewSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  decodeRuleCatalogData,
  type RuleCatalogReadStore,
} from "@bitsentry-escalator/features/application";
export function postgresRuleCatalogReadStore(
  db: PoolClient,
  scope: WorkspaceId,
): RuleCatalogReadStore {
  return {
    async list(input) {
      const rows = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_catalog WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND ($4::text IS NULL OR id>$4) ORDER BY id LIMIT $5::integer",
        [
          scope,
          input.serviceId,
          input.environmentId,
          input.after ?? null,
          input.limit + 1,
        ],
      );
      return rows.rows.map((r) =>
        decodeRuleCatalogData(scope, "catalog", r.data),
      );
    },
    async get(id) {
      const rows = await db.query<{
        catalog: unknown;
        rule_id: string;
        revision: string;
        definition: Record<string, unknown>;
      }>(
        "SELECT c.data AS catalog,v.rule_id,v.revision::text,v.definition FROM escalator_rule_catalog c JOIN escalator_rule_version v ON(v.workspace_id,v.rule_id,v.revision)=(c.workspace_id,c.id,c.version_revision) WHERE c.workspace_id=$1 AND c.id=$2",
        [scope, id],
      );
      const row = rows.rows[0];
      return row
        ? ruleCatalogViewSchema.parse({
            entry: decodeRuleCatalogData(scope, "catalog", row.catalog),
            version: {
              id: row.rule_id,
              revision: Number(row.revision),
              definition: { ...row.definition, workspaceId: scope },
            },
          })
        : undefined;
    },
    async history(input) {
      const rows = await db.query<{ data: unknown }>(
        "SELECT data FROM escalator_rule_activation WHERE workspace_id=$1 AND rule_id=$2 AND ($3::bigint IS NULL OR catalog_revision<$3::bigint) ORDER BY catalog_revision DESC LIMIT $4::integer",
        [scope, input.ruleId, input.afterRevision ?? null, input.limit + 1],
      );
      return rows.rows.map((r) =>
        decodeRuleCatalogData(scope, "history", r.data),
      );
    },
  };
}
