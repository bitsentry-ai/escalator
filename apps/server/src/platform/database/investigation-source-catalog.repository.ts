import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type {
  WorkspaceId,
  InvestigationSourceOptionsQuery,
} from "@bitsentry-escalator/features/contracts";
import type { InvestigationSourceCatalog } from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
export class PostgresInvestigationSourceCatalog implements InvestigationSourceCatalog {
  private readonly foundation: PostgresFoundationRepository;
  constructor(
    pool: Pool,
    private readonly repositoryConnections = new RepositoryConnections(),
  ) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  list(workspaceId: WorkspaceId, input: InvestigationSourceOptionsQuery) {
    return this.foundation.withConnection(workspaceId, async (base, db) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      if (
        !(await base.services.get(input.serviceId)) ||
        !(await base.environments.get(input.environmentId))
      )
        return { items: [], next: null };
      if (input.kind === "log") return { items: [], next: null };
      if (input.kind === "git_diff") {
        const scope = {
          workspaceId,
          serviceId: input.serviceId,
          environmentId: input.environmentId,
        };
        const page = this.repositoryConnections.list(workspaceId, input);
        const bindings = new Map(
          page.items.map((item) => [
            item.sourceId,
            this.repositoryConnections.get(scope, item.sourceId),
          ]),
        );
        const targetIds = [
          ...new Set(
            [...bindings.values()].flatMap((value) =>
              value ? [value.targetId] : [],
            ),
          ),
        ];
        const secretIds = [
          ...new Set(
            [...bindings.values()].flatMap((value) =>
              value?.secretId ? [value.secretId] : [],
            ),
          ),
        ];
        const targets =
          targetIds.length === 0
            ? []
            : (
                await db.query<{ id: string }>(
                  `SELECT id FROM escalator_deploy_target WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND id=ANY($4::text[]) AND data->'enabled'='true'::jsonb LIMIT 101`,
                  [
                    workspaceId,
                    input.serviceId,
                    input.environmentId,
                    targetIds,
                  ],
                )
              ).rows;
        const secrets =
          secretIds.length === 0
            ? []
            : (
                await db.query<{ id: string }>(
                  `SELECT id FROM escalator_secret WHERE workspace_id=$1 AND id=ANY($2::text[]) AND purpose='provider' AND disabled_at IS NULL LIMIT 101`,
                  [workspaceId, secretIds],
                )
              ).rows;
        const targetSet = new Set(targets.map((row) => row.id));
        const secretSet = new Set(secrets.map((row) => row.id));
        return {
          ...page,
          items: page.items.map((item) => {
            const binding = bindings.get(item.sourceId);
            return {
              ...item,
              enabled: Boolean(
                item.enabled &&
                binding &&
                targetSet.has(binding.targetId) &&
                (binding.secretId === null || secretSet.has(binding.secretId)),
              ),
            };
          }),
        };
      }
      const tables = {
        probe: "escalator_probe",
        alert: "escalator_signal_source",
        metric: "escalator_metric_monitor",
        deployment: "escalator_deploy_target",
      } as const;
      const result = await db.query<{
        id: string;
        name: string;
        enabled: boolean;
      }>(
        `SELECT id,LEFT(COALESCE(NULLIF(data->>'name',''),id),200) AS name,COALESCE((data->>'enabled')::boolean,false) AS enabled FROM ${tables[input.kind]} WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND ($4::text IS NULL OR id>$4)${input.kind === "alert" ? " AND data->>'kind' IN ('generic','sentry','glitchtip','grafana')" : ""} ORDER BY id COLLATE "C" LIMIT $5`,
        [
          workspaceId,
          input.serviceId,
          input.environmentId,
          input.after ?? null,
          input.limit + 1,
        ],
      );
      return {
        items: result.rows.slice(0, input.limit).map((row) => ({
          kind: input.kind,
          sourceId: row.id,
          name: row.name,
          enabled: row.enabled,
        })),
        next:
          result.rows.length > input.limit
            ? result.rows[input.limit - 1].id
            : null,
      };
    });
  }
}
