import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { PoolClient } from "pg";
import {
  deploymentWatchRecordSchema,
  deploymentBaselinePinSeconds,
  type WorkspaceId,
  type DeploymentWatchRecord,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  type DeploymentWatchStore,
} from "@bitsentry-escalator/features/application";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { watchSourceLocksSql } from "./deployment-baseline-sql.js";
const data = (value: DeploymentWatchRecord) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
/** Target lock is held by the shared decorator. Capture-source locks precede
 * watch pins and any work enqueue; no network I/O occurs on this connection.
 */
export function postgresDeploymentWatchStore(
  db: PoolClient,
  scope: WorkspaceId,
  repositoryConnections = new RepositoryConnections(),
): DeploymentWatchStore {
  const paging = postgresPagingStore(db, scope, repositoryConnections);
  return {
    async get(targetId, deploymentId) {
      const result = await db.query<{ data: object }>(
        "SELECT data FROM escalator_deployment_watch WHERE workspace_id=$1 AND target_id=$2 AND deployment_id=$3",
        [scope, targetId, deploymentId],
      );
      return result.rows[0]
        ? deploymentWatchRecordSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async insert(value, baseline) {
      if (value.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const sources = baseline?.streams.map((stream) => stream.sourceId) ?? [];
      const locked = await db.query<{ id: string }>(watchSourceLocksSql, [
        scope,
        value.serviceId,
        value.environmentId,
        sources,
      ]);
      if (locked.rows.length !== sources.length)
        throw new Error("Captured watch source is missing");
      await db.query(
        `INSERT INTO escalator_deployment_watch
        (workspace_id,deployment_id,target_id,service_id,environment_id,revision,started_at,ends_at,updated_at,finalized_at,verdict,incident_id,data)
        VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11,$12,$13::jsonb)`,
        [
          scope,
          value.deploymentId,
          value.targetId,
          value.serviceId,
          value.environmentId,
          value.revision,
          value.startedAt,
          value.endsAt,
          value.updatedAt,
          value.finalizedAt,
          value.verdict,
          value.incidentId,
          data(value),
        ],
      );
      if (sources.length)
        await db.query(
          `INSERT INTO escalator_deployment_pin
        (workspace_id,deployment_id,source_id,service_id,environment_id,purpose,starts_at,ends_at,created_at,expires_at)
        SELECT $1,$2,s.id,$3,$4,'watch',$5::timestamptz,$6::timestamptz,$5::timestamptz,$7::timestamptz
        FROM unnest($8::text[]) AS s(id)`,
          [
            scope,
            value.deploymentId,
            value.serviceId,
            value.environmentId,
            value.startedAt,
            value.endsAt,
            new Date(
              Date.parse(value.startedAt) + deploymentBaselinePinSeconds * 1000,
            ).toISOString(),
            sources,
          ],
        );
    },
    async replace(value, expectedRevision) {
      if (value.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const result = await db.query(
        `UPDATE escalator_deployment_watch SET
        revision=$4,updated_at=$5::timestamptz,finalized_at=$6::timestamptz,verdict=$7,incident_id=$8,data=$9::jsonb
        WHERE workspace_id=$1 AND target_id=$2 AND deployment_id=$3 AND revision=$10 AND finalized_at IS NULL`,
        [
          scope,
          value.targetId,
          value.deploymentId,
          value.revision,
          value.updatedAt,
          value.finalizedAt,
          value.verdict,
          value.incidentId,
          data(value),
          expectedRevision,
        ],
      );
      return result.rowCount === 1;
    },
    incident: (id) => paging.get("incidents", id),
  };
}
