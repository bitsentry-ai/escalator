import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import { readRepositoryBinding } from "../../../platform/database/postgres-repository-evidence.js";
import type { PoolClient } from "pg";
import type { InvestigationScope } from "@bitsentry-escalator/features/contracts";
import type { InvestigationConfiguration } from "@bitsentry-escalator/features/investigation";
import { postgresInvestigationSettingsStore } from "../../../platform/database/postgres-investigation-settings.store.js";
const tables = {
  probe: "escalator_probe",
  alert: "escalator_signal_source",
  metric: "escalator_metric_monitor",
  deployment: "escalator_deploy_target",
} as const;
type SourceVersion = InvestigationConfiguration["sourceVersions"][number];
/**
 * An unavailable binding matches capture's "missing" revision and approves no credential; the repository read then
 * reports that source unavailable.
 */
async function repositorySourceVersion(
  db: PoolClient,
  scope: InvestigationScope,
  source: { kind: "git_diff"; sourceId: string },
  repositoryConnections: RepositoryConnections,
): Promise<{ version: SourceVersion; secretId: string | null }> {
  const binding = await readRepositoryBinding(
    db,
    scope,
    source.sourceId,
    repositoryConnections,
  );
  return {
    version: {
      kind: source.kind,
      sourceId: source.sourceId,
      revision: binding?.revision ?? "missing",
    },
    secretId: binding?.connection.secretId ?? null,
  };
}
/** The signal source a probe or metric monitor reads, locked, and whether it is enabled. */
async function lockedParent(
  db: PoolClient,
  scope: InvestigationScope,
  source: { kind: "probe" | "metric"; sourceId: string },
): Promise<{ parent: string | undefined; parentAvailable: boolean }> {
  const hint = await db.query<{ source_id: string }>(
    `SELECT source_id FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4`,
    [scope.workspaceId, source.sourceId, scope.serviceId, scope.environmentId],
  );
  const parent = hint.rows[0]?.source_id;
  if (!parent) return { parent, parentAvailable: true };
  const locked = await db.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM escalator_signal_source WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE",
    [scope.workspaceId, parent, scope.serviceId, scope.environmentId],
  );
  return { parent, parentAvailable: locked.rows[0]?.data.enabled === true };
}
/**
 * The locked revision of a native source, "missing" when it or its enabled signal source is gone, or undefined
 * when a probe or metric monitor no longer belongs to the signal source it was read under.
 */
async function nativeSourceRevision(
  db: PoolClient,
  scope: InvestigationScope,
  source: { kind: keyof typeof tables; sourceId: string },
): Promise<string | undefined> {
  const child = source.kind === "probe" || source.kind === "metric";
  const { parent, parentAvailable } =
    source.kind === "probe" || source.kind === "metric"
      ? await lockedParent(db, scope, {
          kind: source.kind,
          sourceId: source.sourceId,
        })
      : { parent: undefined, parentAvailable: true };
  const found = await db.query<{
    data: Record<string, unknown>;
    source_id?: string;
  }>(
    `SELECT data${child ? ",source_id" : ""} FROM ${tables[source.kind]} WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE`,
    [scope.workspaceId, source.sourceId, scope.serviceId, scope.environmentId],
  );
  const row = found.rows[0];
  if (row && child && row.source_id !== parent) return undefined;
  const available =
    parentAvailable &&
    (!row || source.kind === "deployment" || row.data.enabled === true);
  const revisionField = source.kind === "deployment" ? "revision" : "version";
  return row && available ? String(row.data[revisionField]) : "missing";
}
/** Locks the enabled service and the environment; false when either is gone. */
async function lockScope(
  db: PoolClient,
  scope: InvestigationScope,
): Promise<boolean> {
  const service = await db.query(
    "SELECT id FROM escalator_service WHERE workspace_id=$1 AND id=$2 AND enabled=true FOR SHARE",
    [scope.workspaceId, scope.serviceId],
  );
  if (!service.rowCount) return false;
  const environment = await db.query(
    "SELECT id FROM escalator_environment WHERE workspace_id=$1 AND id=$2 FOR SHARE",
    [scope.workspaceId, scope.environmentId],
  );
  return Boolean(environment.rowCount);
}
/** Locks the profile's enabled provider secret, then the profile itself; false when either is gone. */
async function lockProfile(
  db: PoolClient,
  scope: InvestigationScope,
  profileId: string,
  secretId: string | null | undefined,
): Promise<boolean> {
  if (secretId) {
    const secret = await db.query(
      "SELECT id FROM escalator_secret WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL AND purpose='provider' FOR SHARE",
      [scope.workspaceId, secretId],
    );
    if (!secret.rowCount) return false;
  }
  const locked = await db.query(
    "SELECT id FROM escalator_investigation_settings WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4 FOR SHARE",
    [scope.workspaceId, profileId, scope.serviceId, scope.environmentId],
  );
  return Boolean(locked.rowCount);
}
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
  if (!(await lockScope(db, scope))) return undefined;
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
    if (source.kind === "log") return undefined;
    if (source.kind === "git_diff") {
      const repository = await repositorySourceVersion(
        db,
        scope,
        { kind: source.kind, sourceId: source.sourceId },
        repositoryConnections,
      );
      versions.push(repository.version);
      if (repository.secretId !== null) secretIds.add(repository.secretId);
      continue;
    }
    const revision = await nativeSourceRevision(db, scope, {
      kind: source.kind,
      sourceId: source.sourceId,
    });
    if (revision === undefined) return undefined;
    versions.push({ kind: source.kind, sourceId: source.sourceId, revision });
  }
  if (!(await lockProfile(db, scope, profileId, selected.profile.secretId)))
    return undefined;
  const current = await store.selected(scope);
  if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(selected))
    return undefined;
  return {
    profile: current.profile,
    secretIds: [...secretIds],
    sourceVersions: versions,
  };
}
