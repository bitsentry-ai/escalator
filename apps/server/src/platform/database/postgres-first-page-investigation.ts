import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import { captureRepositorySources } from "./postgres-repository-capture.js";
import type { PoolClient } from "pg";
import type {
  OperationalIncident,
  WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  firstPageInvestigation,
  type InvestigationConfiguration,
} from "@bitsentry-escalator/features/investigation";
import { postgresInvestigationSettingsStore } from "./postgres-investigation-settings.store.js";
import { PostgresInvestigationRepository } from "./postgres-investigation.repository.js";

/** Joins first-page persistence. Only bounded local metadata reads; never redeems a secret. */
export async function enqueueFirstPageInvestigation(
  db: PoolClient,
  workspaceId: WorkspaceId,
  incident: OperationalIncident,
  repositoryConnections = new RepositoryConnections(),
): Promise<void> {
  if (incident.workspaceId !== workspaceId)
    throw new Error("Investigation scope mismatch");
  // Lock first, then read a fresh statement snapshot after a concurrent editor commits.
  // Source metadata reads take no row locks, avoiding inversion with source editors.
  const selected = await db.query(
    "SELECT id FROM escalator_investigation_settings WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 FOR SHARE",
    [workspaceId, incident.serviceId, incident.environmentId],
  );
  if (!selected.rowCount) return;
  const settings = await postgresInvestigationSettingsStore(
    db,
    workspaceId,
  ).selected({
    workspaceId,
    serviceId: incident.serviceId,
    environmentId: incident.environmentId,
  });
  const intent = firstPageInvestigation(incident, settings);
  if (!intent || !settings) return;
  const versions = await db.query<{
    kind: InvestigationConfiguration["sourceVersions"][number]["kind"];
    source_id: string;
    revision: string;
  }>(
    `SELECT l.kind,l.source_id,COALESCE(CASE l.kind
       WHEN 'probe' THEN p.data->>'version'
       WHEN 'alert' THEN a.data->>'version'
       WHEN 'metric' THEN m.data->>'version'
       WHEN 'deployment' THEN d.data->>'revision' END,'missing') AS revision
     FROM escalator_investigation_source_link l
     LEFT JOIN escalator_probe p ON l.kind='probe' AND p.workspace_id=l.workspace_id AND p.id=l.source_id AND p.service_id=$3 AND p.environment_id=$4
     LEFT JOIN escalator_signal_source a ON l.kind='alert' AND a.workspace_id=l.workspace_id AND a.id=l.source_id AND a.service_id=$3 AND a.environment_id=$4
     LEFT JOIN escalator_metric_monitor m ON l.kind='metric' AND m.workspace_id=l.workspace_id AND m.id=l.source_id AND m.service_id=$3 AND m.environment_id=$4
     LEFT JOIN escalator_deploy_target d ON l.kind='deployment' AND d.workspace_id=l.workspace_id AND d.id=l.source_id AND d.service_id=$3 AND d.environment_id=$4
     WHERE l.workspace_id=$1 AND l.profile_id=$2 ORDER BY l.position LIMIT 33`,
    [
      workspaceId,
      settings.profile.id,
      incident.serviceId,
      incident.environmentId,
    ],
  );
  const repositories = await captureRepositorySources(
    db,
    {
      workspaceId,
      serviceId: incident.serviceId,
      environmentId: incident.environmentId,
    },
    settings.sources,
    repositoryConnections,
  );
  const repositoryVersions = new Map(
    repositories.sourceVersions.map((source) => [
      source.sourceId,
      source.revision,
    ]),
  );
  const configuration: InvestigationConfiguration = {
    profile: settings.profile,
    secretIds: [
      ...new Set([
        ...(settings.profile.secretId === null
          ? []
          : [settings.profile.secretId]),
        ...repositories.secretIds,
      ]),
    ],
    sourceVersions: versions.rows.map(({ kind, source_id, revision }) => ({
      kind,
      sourceId: source_id,
      revision:
        kind === "git_diff"
          ? (repositoryVersions.get(source_id) ?? "missing")
          : revision,
    })),
  };
  await PostgresInvestigationRepository.createWriter(
    db,
    workspaceId,
    async () => configuration,
  ).enqueue(intent);
}
