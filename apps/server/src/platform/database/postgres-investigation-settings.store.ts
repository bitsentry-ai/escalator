import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import { readRepositoryBinding } from "./postgres-repository-evidence.js";
import type { PoolClient } from "pg";
import {
  investigationSettingsSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type { InvestigationSettingsStore } from "@bitsentry-escalator/features/application";
import { compareCodeUnits } from "@bitsentry-escalator/features/contracts";
/** Fixed SQL primitives on the surrounding scoped transaction; no network calls. */
export function postgresInvestigationSettingsStore(
  db: PoolClient,
  workspaceId: WorkspaceId,
  repositoryConnections = new RepositoryConnections(),
): InvestigationSettingsStore {
  async function read(
    id: string | null,
    serviceId: string | null = null,
    environmentId: string | null = null,
  ) {
    // A single statement gives the profile and normalized links the same MVCC snapshot.
    const result = await db.query<{
      data: Record<string, unknown>;
      sources: unknown;
    }>(
      `SELECT s.data, COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',l.kind,'sourceId',l.source_id,'lookbackMs',l.lookback_ms,'limit',l.result_limit) ORDER BY l.position) FROM escalator_investigation_source_link l WHERE l.workspace_id=s.workspace_id AND l.profile_id=s.id),'[]'::jsonb) AS sources
       FROM escalator_investigation_settings s WHERE s.workspace_id=$1 AND ($2::text IS NULL OR s.id=$2) AND ($3::text IS NULL OR s.service_id=$3) AND ($4::text IS NULL OR s.environment_id=$4)`,
      [workspaceId, id, serviceId, environmentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const profile = row.data.profile as Record<string, unknown>;
    return investigationSettingsSchema.parse({
      ...row.data,
      profile: {
        ...profile,
        scope: { ...(profile.scope as Record<string, unknown>), workspaceId },
      },
      sources: row.sources,
    });
  }
  return {
    async lockScope(scope) {
      if (scope.workspaceId !== workspaceId) return false;
      const service = await db.query(
        "SELECT id FROM escalator_service WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspaceId, scope.serviceId],
      );
      if (!service.rowCount) return false;
      const environment = await db.query(
        "SELECT id FROM escalator_environment WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspaceId, scope.environmentId],
      );
      return Boolean(environment.rowCount);
    },
    get: (id) => read(id),
    selected: (scope) => read(null, scope.serviceId, scope.environmentId),
    async authorizeSources(actor, scope, sources) {
      if (
        actor.workspaceId !== workspaceId ||
        scope.workspaceId !== workspaceId
      )
        return false;
      // Sort locks independently of display order. Existing external sources need explicit links
      // and their own ownership policy; a missing catalog entry never grants ambient access.
      const sorted = [...sources].sort((a, b) => {
        const left = `${a.kind}:${a.sourceId}`;
        const right = `${b.kind}:${b.sourceId}`;
        return compareCodeUnits(left, right);
      });
      for (const source of sorted) {
        const tables = {
          probe: "escalator_probe",
          alert: "escalator_signal_source",
          metric: "escalator_metric_monitor",
          deployment: "escalator_deploy_target",
        } as const;
        if (source.kind === "log") return false;
        if (source.kind === "git_diff") {
          if (
            !(await readRepositoryBinding(
              db,
              scope,
              source.sourceId,
              repositoryConnections,
            ))
          )
            return false;
          continue;
        }
        if (source.kind === "probe" || source.kind === "metric") {
          const hint = await db.query<{ source_id: string }>(
            `SELECT source_id FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4`,
            [
              workspaceId,
              source.sourceId,
              scope.serviceId,
              scope.environmentId,
            ],
          );
          if (!hint.rows[0]) return false;
          const parent = await db.query(
            "SELECT id FROM escalator_signal_source WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR UPDATE",
            [
              workspaceId,
              hint.rows[0].source_id,
              scope.serviceId,
              scope.environmentId,
            ],
          );
          if (!parent.rowCount) return false;
        }
        const result = await db.query<{ data: Record<string, unknown> }>(
          `SELECT data FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR UPDATE`,
          [workspaceId, source.sourceId, scope.serviceId, scope.environmentId],
        );
        if (!result.rows[0]) return false;
        if (
          source.kind === "alert" &&
          !["sentry", "glitchtip", "grafana", "generic"].includes(
            String(result.rows[0].data.kind),
          )
        )
          return false;
      }
      return true;
    },
    async authorizeSecret(actor, profile) {
      if (
        actor.workspaceId !== workspaceId ||
        profile.scope.workspaceId !== workspaceId ||
        !profile.secretId
      )
        return false;
      const result = await db.query(
        "SELECT id FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL FOR UPDATE",
        [workspaceId, profile.secretId],
      );
      return Boolean(result.rowCount);
    },
    async put(value, expected) {
      const { sources, profile, ...rest } = value;
      const identity = {
        serviceId: profile.scope.serviceId,
        environmentId: profile.scope.environmentId,
      };
      const data = JSON.stringify({
        ...rest,
        profile: { ...profile, scope: identity },
      });
      const args = [
        workspaceId,
        profile.id,
        profile.scope.serviceId,
        profile.scope.environmentId,
        profile.secretId,
        profile.revision,
        value.enabled,
        data,
      ];
      const result =
        expected === null
          ? await db.query(
              "INSERT INTO escalator_investigation_settings(workspace_id,id,service_id,environment_id,model_secret_id,revision,enabled,data) VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING id",
              args,
            )
          : await db.query(
              "UPDATE escalator_investigation_settings SET model_secret_id=$5,revision=$6::bigint,enabled=$7,data=$8::jsonb WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 AND revision=$9::bigint RETURNING id",
              [...args, expected],
            );
      if (!result.rowCount) return false;
      await db.query(
        "DELETE FROM escalator_investigation_source_link WHERE workspace_id=$1 AND profile_id=$2",
        [workspaceId, profile.id],
      );
      for (const [position, source] of sources.entries())
        await db.query(
          "INSERT INTO escalator_investigation_source_link(workspace_id,profile_id,position,kind,source_id,lookback_ms,result_limit) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            workspaceId,
            profile.id,
            position,
            source.kind,
            source.sourceId,
            source.lookbackMs,
            source.limit,
          ],
        );
      return true;
    },
  };
}
