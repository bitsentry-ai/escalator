import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import { readRepositoryBinding } from "../../../platform/database/postgres-repository-evidence.js";
import type { PoolClient } from "pg";
import type { InvestigationScope } from "@bitsentry-escalator/features/contracts";
import type { InvestigationConfiguration } from "@bitsentry-escalator/features/investigation";
import { postgresInvestigationSettingsStore } from "../../../platform/database/postgres-investigation-settings.store.js";
/** Must execute inside the repository's bounded, tenant-scoped transaction. No network. */
export async function standaloneInvestigationConfiguration(
  db: PoolClient,
  scope: InvestigationScope,
  profileId: string,
  repositoryConnections = new RepositoryConnections(),
): Promise<InvestigationConfiguration | undefined> {
  const store = postgresInvestigationSettingsStore(db, scope.workspaceId);
  // Read locks protect metadata while remaining compatible with paging FK key-share locks.
  // Keep the settings writer order: service/environment, sources, secret, profile.
  const service = await db.query(
    "SELECT id FROM escalator_service WHERE workspace_id=$1 AND id=$2 AND enabled=true FOR SHARE",
    [scope.workspaceId, scope.serviceId],
  );
  if (!service.rowCount) return undefined;
  const environment = await db.query(
    "SELECT id FROM escalator_environment WHERE workspace_id=$1 AND id=$2 FOR SHARE",
    [scope.workspaceId, scope.environmentId],
  );
  if (!environment.rowCount) return undefined;
  const selected = await store.selected(scope);
  if (!selected?.enabled || selected.profile.id !== profileId) return undefined;
  const versions: InvestigationConfiguration["sourceVersions"] = [];
  const secretIds = new Set<string>(
    selected.profile.secretId ? [selected.profile.secretId] : [],
  );
  const sorted = [...selected.sources].sort((a, b) =>
    `${a.kind}:${a.sourceId}` < `${b.kind}:${b.sourceId}` ? -1 : 1,
  );
  for (const source of sorted) {
    const tables = {
      probe: "escalator_probe",
      alert: "escalator_signal_source",
      metric: "escalator_metric_monitor",
      deployment: "escalator_deploy_target",
    } as const;
    if (source.kind === "log") return undefined;
    if (source.kind === "git_diff") {
      const binding = await readRepositoryBinding(
        db,
        scope,
        source.sourceId,
        repositoryConnections,
      );
      // An unavailable binding matches capture's "missing" revision and approves no
      // credential; the repository read then reports that source unavailable.
      versions.push({
        kind: source.kind,
        sourceId: source.sourceId,
        revision: binding?.revision ?? "missing",
      });
      if (binding && binding.connection.secretId !== null)
        secretIds.add(binding.connection.secretId);
      continue;
    }
    let parent: string | undefined;
    let parentAvailable = true;
    if (source.kind === "probe" || source.kind === "metric") {
      const hint = await db.query<{ source_id: string }>(
        `SELECT source_id FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4`,
        [
          scope.workspaceId,
          source.sourceId,
          scope.serviceId,
          scope.environmentId,
        ],
      );
      parent = hint.rows[0]?.source_id;
      if (parent) {
        const locked = await db.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM escalator_signal_source WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE",
          [scope.workspaceId, parent, scope.serviceId, scope.environmentId],
        );
        parentAvailable = locked.rows[0]?.data.enabled === true;
      }
    }
    const found = await db.query<{
      data: Record<string, unknown>;
      source_id?: string;
    }>(
      `SELECT data${source.kind === "probe" || source.kind === "metric" ? ",source_id" : ""} FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE`,
      [
        scope.workspaceId,
        source.sourceId,
        scope.serviceId,
        scope.environmentId,
      ],
    );
    const row = found.rows[0];
    if (
      row &&
      (source.kind === "probe" || source.kind === "metric") &&
      row.source_id !== parent
    )
      return undefined;
    const available =
      parentAvailable &&
      (!row || source.kind === "deployment" || row.data.enabled === true);
    const revisionField = source.kind === "deployment" ? "revision" : "version";
    versions.push({
      kind: source.kind,
      sourceId: source.sourceId,
      revision: row && available ? String(row.data[revisionField]) : "missing",
    });
  }
  if (selected.profile.secretId) {
    const secret = await db.query(
      "SELECT id FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL AND purpose='provider' FOR SHARE",
      [scope.workspaceId, selected.profile.secretId],
    );
    if (!secret.rowCount) return undefined;
  }
  const locked = await db.query(
    "SELECT id FROM escalator_investigation_settings WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE",
    [scope.workspaceId, profileId, scope.serviceId, scope.environmentId],
  );
  if (!locked.rowCount) return undefined;
  const current = await store.selected(scope);
  if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(selected))
    return undefined;
  return {
    profile: current.profile,
    secretIds: [...secretIds],
    sourceVersions: versions,
  };
}
