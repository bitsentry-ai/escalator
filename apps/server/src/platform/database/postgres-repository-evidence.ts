import type { PoolClient } from "pg";
import {
  evidenceQuerySchema,
  investigationScopeSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type EvidenceQuery,
  type InvestigationScope,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  repositoryConnectionRevision,
  repositoryComparisonFromDeployments,
  type RepositoryConnection,
  type ModelScope,
} from "@bitsentry-escalator/features/investigation";

/** Only local metadata reads inside the caller's bounded, workspace-scoped transaction.
 * The caller must fence the persisted investigation claim before and after use.
 * Never hold these locks while retrieving credentials or making provider requests.
 */
export async function readRepositoryBinding(
  db: PoolClient,
  scopeInput: ModelScope,
  sourceIdInput: string,
  connections: RepositoryConnections,
) {
  const scope = investigationScopeSchema
    .pick({ workspaceId: true, serviceId: true, environmentId: true })
    .parse({
      workspaceId: scopeInput.workspaceId,
      serviceId: scopeInput.serviceId,
      environmentId: scopeInput.environmentId,
    });
  const sourceId = opaqueIdSchema.parse(sourceIdInput);
  const connection = connections.get(scope, sourceId);
  if (!connection?.enabled) return undefined;
  const target = await db.query<{ revision: string; enabled: boolean }>(
    `SELECT revision::text,COALESCE((data->>'enabled')::boolean,false) AS enabled
     FROM escalator_deploy_target
     WHERE workspace_id=$1 AND id=$2 AND service_id=$3 AND environment_id=$4
     FOR SHARE`,
    [
      scope.workspaceId,
      connection.targetId,
      scope.serviceId,
      scope.environmentId,
    ],
  );
  const row = target.rows[0];
  if (!row?.enabled) return undefined;
  if (connection.secretId !== null) {
    const secret = await db.query(
      `SELECT id FROM escalator_secret
       WHERE workspace_id=$1 AND id=$2 AND purpose='provider' AND disabled_at IS NULL
       FOR SHARE`,
      [scope.workspaceId, connection.secretId],
    );
    if (!secret.rowCount) return undefined;
  }
  return {
    connection,
    revision: repositoryConnectionRevision(connection, row.revision),
  };
}

/** Select both deployments in one statement. A late finish cannot retrospectively
 * become the baseline of an earlier deployment. The shared validator checks the
 * selected records again, including immutable SHAs and receipt provenance.
 */
export async function readRepositoryComparison(
  db: PoolClient,
  scopeInput: InvestigationScope,
  queryInput: EvidenceQuery,
  connection: RepositoryConnection,
  asOfInput: string,
) {
  const scope = investigationScopeSchema.parse(scopeInput);
  const query = evidenceQuerySchema.parse(queryInput);
  const asOf = utcTimestampSchema.parse(asOfInput);
  // Validate the connection and source before issuing even a local read.
  const snapshot = new RepositoryConnections([connection]);
  if (
    query.kind !== "git_diff" ||
    !snapshot.get(scope, query.sourceId)?.enabled
  )
    return undefined;
  const result = await db.query<{
    head: Record<string, unknown>;
    base: Record<string, unknown> | null;
  }>(
    `SELECT jsonb_build_object('targetId',h.target_id,'record',h.data || jsonb_build_object('workspaceId',$1::text)) AS head,
       CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_build_object('targetId',b.target_id,'record',b.data || jsonb_build_object('workspaceId',$1::text)) END AS base
     FROM (
       SELECT target_id,started_at,data FROM escalator_deployment
       WHERE workspace_id=$1 AND target_id=$2 AND service_id=$3 AND environment_id=$4
         AND started_at BETWEEN $5::timestamptz AND $6::timestamptz
         AND (data->>'acceptedAt')::timestamptz <= $7::timestamptz
       ORDER BY started_at DESC,id COLLATE "C" DESC LIMIT 1
     ) h
     LEFT JOIN LATERAL (
       SELECT id,target_id,data FROM escalator_deployment
       WHERE workspace_id=$1 AND target_id=$2 AND service_id=$3 AND environment_id=$4
         AND status='SUCCEEDED'
         AND (data->'finish'->>'occurredAt')::timestamptz <= h.started_at
         AND (data->'finish'->>'receivedAt')::timestamptz <= (h.data->>'acceptedAt')::timestamptz
         AND id <> h.data->>'id'
       ORDER BY (data->'finish'->>'occurredAt')::timestamptz DESC,id COLLATE "C" DESC LIMIT 1
     ) b ON true`,
    [
      scope.workspaceId,
      connection.targetId,
      scope.serviceId,
      scope.environmentId,
      query.window.from,
      query.window.to,
      asOf,
    ],
  );
  return repositoryComparisonFromDeployments(
    scope,
    query,
    connection,
    result.rows[0]?.head,
    result.rows[0]?.base,
    asOf,
  );
}
