import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  deploymentTransaction,
  withDeploymentBaseline,
  type DeploymentRepository,
  type BaselineTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresDeploymentBaselineStore } from "./postgres-deployment-baseline.store.js";
/** Adapter conformance entry point. Runtime registration follows Dashboard parity.
 * Future composition puts withDeploymentTimeout OUTSIDE this decorator, so source
 * locks and baseline pins precede work enqueueing, matching retention's lock order.
 */
export class PostgresDeploymentBaselineRepository implements DeploymentRepository {
  private readonly foundation: PostgresFoundationRepository;
  private readonly deployments: PostgresDeploymentRepository;
  constructor(pool: Pool) {
    this.foundation = new PostgresFoundationRepository(pool);
    this.deployments = new PostgresDeploymentRepository(pool);
  }
  findTokenContext(hash: string) {
    return this.deployments.findTokenContext(hash);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: BaselineTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        await connection.query(
          "SELECT set_config('app.deployment_token_hash','',true)",
        );
        return run(
          withDeploymentBaseline(
            deploymentTransaction(
              base,
              postgresDeploymentStore(connection, scope),
              guard,
            ),
            postgresDeploymentBaselineStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
