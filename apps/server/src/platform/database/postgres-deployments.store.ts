import type { PoolClient } from "pg";
import {
  deploymentTargetSchema,
  deploymentTokenSchema,
  deploymentEntrySchema,
  deploymentReceiptSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  DeploymentRecordStore,
  PageRequest,
} from "@bitsentry-escalator/features/application";
import { postgresConfigurationStore } from "./postgres-configuration.store.js";

const encode = (value: { workspaceId: string }) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
type FlatRow = { data: Record<string, unknown> };
type EntryRow = FlatRow & {
  target_id: string;
  policy: Record<string, unknown>;
};
function page<T>(rows: T[], limit: number, id: (value: T) => string) {
  return {
    items: rows.slice(0, limit),
    next: rows.length > limit ? id(rows[limit - 1]) : null,
  };
}
/** Static identifiers, bound values, and the surrounding foundation transaction only. */
export function postgresDeploymentStore(
  connection: PoolClient,
  scope: WorkspaceId,
): DeploymentRecordStore {
  const configuration = postgresConfigurationStore(connection, scope);
  const target = (data: Record<string, unknown>) =>
    deploymentTargetSchema.parse({ ...data, workspaceId: scope });
  const grant = (data: Record<string, unknown>) =>
    deploymentTokenSchema.parse({ ...data, workspaceId: scope });
  const entry = (row: EntryRow) =>
    deploymentEntrySchema.parse({
      targetId: row.target_id,
      deployment: { ...row.data, workspaceId: scope },
      policy: { ...row.policy, workspaceId: scope },
    });
  async function readFlat(
    kind: "target" | "grant",
    field: "id" | "token_hash",
    value: string,
  ) {
    const result = await connection.query<FlatRow>(
      `SELECT data FROM escalator_deploy_${kind} WHERE workspace_id=$1 AND ${field}=$2 FOR UPDATE`,
      [scope, value],
    );
    return result.rows[0]?.data;
  }
  async function listFlat(
    kind: "target" | "grant",
    query: PageRequest,
    targetId?: string,
  ) {
    const result = await connection.query<FlatRow>(
      `SELECT data FROM escalator_deploy_${kind} WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2)${kind === "grant" ? " AND target_id=$4" : ""} ORDER BY id LIMIT $3`,
      [
        scope,
        query.after ?? null,
        query.limit + 1,
        ...(kind === "grant" ? [targetId] : []),
      ],
    );
    return result.rows.map((row) => row.data);
  }
  return {
    async currentTime() {
      const result = await connection.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      return result.rows[0].now.toISOString();
    },
    getPolicy: (id) => configuration.get("policies", id, true),
    async getTarget(id) {
      const data = await readFlat("target", "id", id);
      return data ? target(data) : undefined;
    },
    async listTargets(query) {
      return page(
        (await listFlat("target", query)).map(target),
        query.limit,
        (value) => value.id,
      );
    },
    async insertTarget(value) {
      await connection.query(
        "INSERT INTO escalator_deploy_target(workspace_id,id,service_id,environment_id,policy_id,revision,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [
          scope,
          value.id,
          value.serviceId,
          value.environmentId,
          value.policyId,
          value.revision,
          encode(value),
        ],
      );
    },
    async replaceTarget(value, expected) {
      const result = await connection.query(
        "UPDATE escalator_deploy_target SET policy_id=$3,revision=$4,data=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND revision=$6",
        [
          scope,
          value.id,
          value.policyId,
          value.revision,
          encode(value),
          expected,
        ],
      );
      return result.rowCount === 1;
    },
    async getTokenByHash(hash) {
      const data = await readFlat("grant", "token_hash", hash);
      return data ? grant(data) : undefined;
    },
    async getToken(id) {
      const data = await readFlat("grant", "id", id);
      return data ? grant(data) : undefined;
    },
    async listTokens(targetId, query) {
      return page(
        (await listFlat("grant", query, targetId)).map(grant),
        query.limit,
        (value) => value.id,
      );
    },
    async insertToken(value) {
      await connection.query(
        "INSERT INTO escalator_deploy_grant(workspace_id,id,target_id,token_hash,mapped_deployer_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [
          scope,
          value.id,
          value.targetId,
          value.tokenHash,
          value.mappedDeployerId,
          encode(value),
        ],
      );
    },
    async revokeToken(id, at) {
      const result = await connection.query(
        "UPDATE escalator_deploy_grant SET data=jsonb_set(data,'{revokedAt}',to_jsonb($3::text)) WHERE workspace_id=$1 AND id=$2 AND data->>'revokedAt' IS NULL",
        [scope, id, at],
      );
      return result.rowCount === 1;
    },
    async getDeployment(targetId, id) {
      const result = await connection.query<EntryRow>(
        "SELECT target_id,data,policy FROM escalator_deployment WHERE workspace_id=$1 AND target_id=$2 AND id=$3 FOR UPDATE",
        [scope, targetId, id],
      );
      return result.rows[0] ? entry(result.rows[0]) : undefined;
    },
    async findDeployment(targetId, source, externalId) {
      const result = await connection.query<EntryRow>(
        "SELECT target_id,data,policy FROM escalator_deployment WHERE workspace_id=$1 AND target_id=$2 AND source=$3 AND external_id=$4 FOR UPDATE",
        [scope, targetId, source, externalId],
      );
      return result.rows[0] ? entry(result.rows[0]) : undefined;
    },
    async listDeployments(targetId, query) {
      const result = await connection.query<EntryRow>(
        "SELECT target_id,data,policy FROM escalator_deployment WHERE workspace_id=$1 AND target_id=$2 AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4",
        [scope, targetId, query.after ?? null, query.limit + 1],
      );
      return page(
        result.rows.map(entry),
        query.limit,
        (value) => value.deployment.id,
      );
    },
    async insertDeployment(value) {
      const d = value.deployment;
      await connection.query(
        "INSERT INTO escalator_deployment(workspace_id,id,target_id,service_id,environment_id,token_id,mapped_deployer_id,policy_id,source,external_id,revision,status,started_at,timeout_at,data,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)",
        [
          scope,
          d.id,
          value.targetId,
          d.serviceId,
          d.environmentId,
          d.tokenId,
          d.mappedDeployerId,
          value.policy.id,
          d.source,
          d.externalId,
          d.revision,
          d.status,
          d.startedAt,
          d.timeoutAt,
          encode(d),
          encode(value.policy),
        ],
      );
    },
    async replaceDeployment(targetId, value, expected) {
      const result = await connection.query(
        "UPDATE escalator_deployment SET revision=$4,status=$5,data=$6::jsonb WHERE workspace_id=$1 AND target_id=$2 AND id=$3 AND revision=$7",
        [
          scope,
          targetId,
          value.id,
          value.revision,
          value.status,
          encode(value),
          expected,
        ],
      );
      return result.rowCount === 1;
    },
    async getReceipt(targetId, key) {
      const result = await connection.query<FlatRow>(
        "SELECT data FROM escalator_deploy_receipt WHERE workspace_id=$1 AND target_id=$2 AND idempotency_key=$3",
        [scope, targetId, key],
      );
      return result.rows[0]
        ? deploymentReceiptSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async insertReceipt(value) {
      await connection.query(
        "INSERT INTO escalator_deploy_receipt(workspace_id,target_id,idempotency_key,token_id,deployment_id,request_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [
          scope,
          value.targetId,
          value.key,
          value.tokenId,
          value.result.state === "rejected" ? null : value.result.deploymentId,
          value.requestHash,
          encode(value),
        ],
      );
    },
  };
}
