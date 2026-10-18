import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  deploymentTransaction,
  pagingTransaction,
  withDeploymentBaseline,
  withDeploymentWatches,
  type DeploymentWatchTransaction,
  type DeploymentWatchRepository,
  type PagingTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresDeploymentBaselineStore } from "./postgres-deployment-baseline.store.js";
import { postgresDeploymentWatchStore } from "./postgres-deployment-watch.store.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
/** Conformance adapter only until both hosts' durable watch runtime is composed. */
export class PostgresDeploymentWatchRepository implements DeploymentWatchRepository {
  private readonly foundation: PostgresFoundationRepository;
  private readonly deployments: PostgresDeploymentRepository;
  constructor(
    pool: Pool,
    private readonly repositoryConnections = new RepositoryConnections(),
  ) {
    this.foundation = new PostgresFoundationRepository(pool);
    this.deployments = new PostgresDeploymentRepository(pool);
  }
  findTokenContext(hash: string) {
    return this.deployments.findTokenContext(hash);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: DeploymentWatchTransaction & PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(
      scope,
      async (base, connection, guard) => {
        await connection.query("SET LOCAL statement_timeout = '5s'");
        await connection.query("SET LOCAL lock_timeout = '1s'");
        await connection.query(
          "SELECT set_config('app.deployment_token_hash','',true)",
        );
        const paging = pagingTransaction(
          base,
          postgresPagingStore(connection, scope, this.repositoryConnections),
          guard,
        );
        const deployments = deploymentTransaction(
          paging,
          postgresDeploymentStore(connection, scope),
          guard,
        );
        return run(
          withDeploymentWatches(
            withDeploymentBaseline(
              { ...paging, ...deployments },
              postgresDeploymentBaselineStore(connection, scope),
              guard,
            ),
            postgresDeploymentWatchStore(
              connection,
              scope,
              this.repositoryConnections,
            ),
            guard,
          ),
        );
      },
    );
  }
}
