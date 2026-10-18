import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  coverageTransaction,
  deploymentTransaction,
  type CoverageRepository,
  type CoverageTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresCoverageStore } from "./postgres-deployment-coverage.store.js";
export class PostgresCoverageRepository implements CoverageRepository {
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
    run: (tx: CoverageTransaction) => Promise<T>,
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
          coverageTransaction(
            deploymentTransaction(
              base,
              postgresDeploymentStore(connection, scope),
              guard,
            ),
            postgresCoverageStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
