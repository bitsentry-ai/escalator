import type { Pool } from "pg";
import type {
  WorkspaceId,
  InvestigationSourceOptionsQuery,
} from "@bitsentry-escalator/features/contracts";
import type { InvestigationSourceCatalog } from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
export class PostgresInvestigationSourceCatalog implements InvestigationSourceCatalog {
  private readonly foundation: PostgresFoundationRepository;
  constructor(pool: Pool) {
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
      if (input.kind === "log" || input.kind === "git_diff")
        return { items: [], next: null };
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
        items: result.rows
          .slice(0, input.limit)
          .map((row) => ({
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
