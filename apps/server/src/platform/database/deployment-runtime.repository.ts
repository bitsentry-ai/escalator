import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  pagingTransaction,
  withDeploymentTimeout,
  type StuckDeploymentRepository,
  type StuckDeploymentTransaction,
  coverageTransaction,
  deploymentTransaction,
  type CoverageRepository,
  type CoverageTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresCoverageStore } from "./postgres-deployment-coverage.store.js";
import { postgresPagingStore } from "./postgres-paging.store.js";

export class PostgresDeploymentRuntimeRepository
  implements CoverageRepository, StuckDeploymentRepository
{
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
    run: (tx: CoverageTransaction & StuckDeploymentTransaction) => Promise<T>,
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
        const coverage = coverageTransaction(
          deploymentTransaction(
            paging,
            postgresDeploymentStore(connection, scope),
            guard,
          ),
          postgresCoverageStore(connection, scope),
          guard,
        );
        return run(withDeploymentTimeout({ ...paging, ...coverage }, guard));
      },
    );
  }
}
