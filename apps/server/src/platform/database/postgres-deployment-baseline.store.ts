import type { PoolClient } from "pg";
import {
  deploymentBaselineSchema,
  deploymentBaselineSeconds,
  deploymentBaselinePinSeconds,
  type WorkspaceId,
  type DeploymentBaseline,
} from "@bitsentry-escalator/features/contracts";
import {
  baselineFromProjection,
  PersistenceError,
  type DeploymentBaselineStore,
} from "@bitsentry-escalator/features/application";
import {
  baselineSourceLocksSql,
  deploymentBaselineSql,
} from "./deployment-baseline-sql.js";
const withoutScope = (value: object) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "workspaceId"),
  );
export function postgresDeploymentBaselineStore(
  db: PoolClient,
  scope: WorkspaceId,
): DeploymentBaselineStore {
  return {
    async capture(entry) {
      const owner = entry.deployment;
      if (owner.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const binding = [scope, owner.serviceId, owner.environmentId];
      const locked = await db.query<{ id: string }>(
        baselineSourceLocksSql,
        binding,
      );
      const start = new Date(
        Date.parse(owner.startedAt) - deploymentBaselineSeconds * 1000,
      ).toISOString();
      const result = await db.query<{ snapshot: unknown }>(
        deploymentBaselineSql,
        [...binding, start, owner.startedAt, locked.rows.map((row) => row.id)],
      );
      return baselineFromProjection(entry, result.rows[0]?.snapshot);
    },
    async get(targetId, deploymentId) {
      const result = await db.query<{
        data: Omit<DeploymentBaseline, "workspaceId">;
      }>(
        "SELECT data FROM escalator_deployment_baseline WHERE workspace_id=$1 AND target_id=$2 AND deployment_id=$3",
        [scope, targetId, deploymentId],
      );
      const data = result.rows[0]?.data;
      return data
        ? deploymentBaselineSchema.parse({
            ...data,
            workspaceId: scope,
            streams: data.streams.map((stream) => ({
              ...stream,
              evidence: { ...stream.evidence, workspaceId: scope },
            })),
          })
        : undefined;
    },
    async insert(value) {
      if (value.workspaceId !== scope)
        throw new PersistenceError("scope_violation");
      const data = {
        ...withoutScope(value),
        streams: value.streams.map((stream) => ({
          ...stream,
          evidence: withoutScope(stream.evidence),
        })),
      };
      await db.query(
        `INSERT INTO escalator_deployment_baseline
        (workspace_id,deployment_id,target_id,service_id,environment_id,started_at,captured_at,data)
        VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::jsonb)`,
        [
          scope,
          value.deploymentId,
          value.targetId,
          value.serviceId,
          value.environmentId,
          value.startedAt,
          value.capturedAt,
          JSON.stringify(data),
        ],
      );
      const startsAt = new Date(
        Date.parse(value.startedAt) - deploymentBaselineSeconds * 1000,
      ).toISOString();
      const expiresAt = new Date(
        Date.parse(value.capturedAt) + deploymentBaselinePinSeconds * 1000,
      ).toISOString();
      await db.query(
        `INSERT INTO escalator_deployment_pin
        (workspace_id,deployment_id,source_id,service_id,environment_id,purpose,starts_at,ends_at,created_at,expires_at)
        SELECT $1,$2,s.id,$3,$4,'baseline',$5::timestamptz,$6::timestamptz,$7::timestamptz,$8::timestamptz
        FROM unnest($9::text[]) AS s(id)`,
        [
          scope,
          value.deploymentId,
          value.serviceId,
          value.environmentId,
          startsAt,
          value.startedAt,
          value.capturedAt,
          expiresAt,
          value.streams.map((stream) => stream.sourceId),
        ],
      );
    },
  };
}
