import type { PoolClient } from "pg";
import {
  investigationSourceSelectionSchema,
  type InvestigationSourceSelection,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  repositoryConnectionRevision,
  type ModelScope,
  type InvestigationConfiguration,
} from "@bitsentry-escalator/features/investigation";
/** Called while the first-page transaction holds the settings row. One bounded
 * metadata snapshot, no row-lock inversion with source editors, no secret reads.
 * The runner subsequently authorizes the captured bindings under its live claim.
 */
export async function captureRepositorySources(
  db: PoolClient,
  scope: ModelScope,
  selections: readonly InvestigationSourceSelection[],
  connections: RepositoryConnections,
) {
  const requested = investigationSourceSelectionSchema
    .array()
    .max(32)
    .parse(selections)
    .filter((source) => source.kind === "git_diff");
  const configured = requested.map((source) => ({
    source,
    connection: connections.get(scope, source.sourceId),
  }));
  const targetIds = [
    ...new Set(
      configured.flatMap((value) =>
        value.connection?.enabled ? [value.connection.targetId] : [],
      ),
    ),
  ];
  const rows =
    targetIds.length === 0
      ? []
      : (
          await db.query<{ id: string; revision: string; enabled: boolean }>(
            `SELECT id,revision::text,COALESCE((data->>'enabled')::boolean,false) AS enabled
     FROM escalator_deploy_target WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3
       AND id=ANY($4::text[]) ORDER BY id COLLATE "C" LIMIT 33`,
            [
              scope.workspaceId,
              scope.serviceId,
              scope.environmentId,
              targetIds,
            ],
          )
        ).rows;
  const targets = new Map(rows.map((row) => [row.id, row]));
  const sourceVersions: InvestigationConfiguration["sourceVersions"] = [];
  const secretIds = new Set<string>();
  for (const { source, connection } of configured) {
    const target = connection ? targets.get(connection.targetId) : undefined;
    let revision = "missing";
    if (connection?.enabled && target?.enabled) {
      revision = repositoryConnectionRevision(connection, target.revision);
      if (connection.secretId !== null) secretIds.add(connection.secretId);
    }
    sourceVersions.push({
      kind: "git_diff",
      sourceId: source.sourceId,
      revision,
    });
  }
  return { sourceVersions, secretIds: [...secretIds] };
}
