import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  deploymentTransaction,
  pagingTransaction,
  signalTransaction,
  probeTransaction,
  withDeploymentBaseline,
  withDeploymentWatches,
  withWatchCadence,
  type WatchCadenceRepository,
  type WatchCadenceTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresDeploymentBaselineStore } from "./postgres-deployment-baseline.store.js";
import { postgresDeploymentWatchStore } from "./postgres-deployment-watch.store.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresProbeStore } from "./postgres-probes.store.js";
import { postgresWatchCadenceStore } from "./postgres-watch-cadence.store.js";
/** Conformance composition; runtime registration follows the Dashboard adapter. */
export class PostgresWatchCadenceRepository implements WatchCadenceRepository {
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
    run: (tx: WatchCadenceTransaction) => Promise<T>,
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
        const watch = withDeploymentWatches(
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
        );
        const probes = probeTransaction(
          signalTransaction(
            base,
            postgresSignalStore(connection, scope),
            guard,
          ),
          postgresProbeStore(connection, scope),
          guard,
        );
        return run(
          withWatchCadence(
            watch,
            probes,
            postgresWatchCadenceStore(connection, scope),
            guard,
          ),
        );
      },
    );
  }
}
