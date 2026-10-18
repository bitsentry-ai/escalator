import type { Pool } from "pg";
import {
  deploymentTokenSchema,
  workspaceIdSchema,
  opaqueIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  deploymentTransaction,
  type DeploymentRepository,
  type DeploymentTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
export class PostgresDeploymentRepository implements DeploymentRepository {
  private readonly foundation: PostgresFoundationRepository;
  constructor(private readonly pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
  }
  transaction<T>(
    scope: WorkspaceId,
    work: (tx: DeploymentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        await connection.query(
          "SELECT set_config('app.deployment_token_hash','',true)",
        );
        return work(
          deploymentTransaction(
            base,
            postgresDeploymentStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
  async findTokenContext(hash: string) {
    deploymentTokenSchema.shape.tokenHash.parse(hash);
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      await connection.query("SET LOCAL lock_timeout = '1s'");
      await connection.query(
        "SELECT set_config('app.workspace_id','',true),set_config('app.deployment_token_hash',$1,true)",
        [hash],
      );
      const result = await connection.query<{
        workspace_id: string;
        target_id: string;
        id: string;
      }>(
        "SELECT workspace_id,target_id,id FROM escalator_deploy_grant WHERE token_hash=$1",
        [hash],
      );
      const row = result.rows[0];
      const context = row
        ? {
            workspaceId: workspaceIdSchema.parse(row.workspace_id),
            targetId: opaqueIdSchema.parse(row.target_id),
            id: opaqueIdSchema.parse(row.id),
          }
        : undefined;
      await connection.query("COMMIT");
      return context;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
