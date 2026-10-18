import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  pagingTransaction,
  configurationTransaction,
  signalTransaction,
  detectionTransaction,
  probeTransaction,
  deploymentTransaction,
  coverageTransaction,
  withDeploymentBaseline,
  withDeploymentWatches,
  withDeploymentWatchJobs,
  withDeploymentTimeout,
  withWatchCadence,
  watchIncidentCorrelation,
  evaluateWatchProjection,
  type CoverageRepository,
  type StuckDeploymentRepository,
  type WatchRuntimeRepository,
  type WatchCadenceRepository,
  type CoverageTransaction,
  type StuckDeploymentTransaction,
  type WatchRuntimeTransaction,
  type WatchCadenceTransaction,
} from "@bitsentry-escalator/features/application";
import { PostgresFoundationRepository } from "./foundation.repository.js";
import { PostgresDeploymentRepository } from "./deployments.repository.js";
import { postgresPagingStore } from "./postgres-paging.store.js";
import { postgresConfigurationStore } from "./postgres-configuration.store.js";
import { postgresSignalStore } from "./postgres-signals.store.js";
import { postgresDetectionStore } from "./postgres-detection.store.js";
import { postgresProbeStore } from "./postgres-probes.store.js";
import { postgresDeploymentStore } from "./postgres-deployments.store.js";
import { postgresCoverageStore } from "./postgres-deployment-coverage.store.js";
import { postgresDeploymentBaselineStore } from "./postgres-deployment-baseline.store.js";
import { postgresDeploymentWatchStore } from "./postgres-deployment-watch.store.js";
import { postgresWatchCadenceStore } from "./postgres-watch-cadence.store.js";
import { readPostgresWatchEvidence } from "./postgres-watch-evidence.store.js";
import { readPostgresWatchOverlaps } from "./postgres-watch-overlaps.store.js";
type Transaction = CoverageTransaction &
  StuckDeploymentTransaction &
  WatchRuntimeTransaction &
  WatchCadenceTransaction;
/** One transaction for lifecycle, watch evidence and cadence ownership. */
export class PostgresDeploymentWatchRuntimeRepository
  implements
    CoverageRepository,
    StuckDeploymentRepository,
    WatchRuntimeRepository,
    WatchCadenceRepository
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
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withConnection(scope, async (base, db, guard) => {
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      await db.query("SELECT set_config('app.deployment_token_hash','',true)");
      const paging = pagingTransaction(
        base,
        postgresPagingStore(db, scope, this.repositoryConnections),
        guard,
      );
      const configuration = configurationTransaction(
        paging,
        postgresConfigurationStore(db, scope),
        guard,
      );
      const signals = signalTransaction(
        base,
        postgresSignalStore(db, scope),
        guard,
      );
      const detection = detectionTransaction(
        { ...configuration, ...signals },
        postgresDetectionStore(db, scope),
        guard,
      );
      const coverage = coverageTransaction(
        deploymentTransaction(
          paging,
          postgresDeploymentStore(db, scope),
          guard,
        ),
        postgresCoverageStore(db, scope),
        guard,
      );
      const watch = withDeploymentWatches(
        withDeploymentBaseline(
          { ...paging, ...coverage },
          postgresDeploymentBaselineStore(db, scope),
          guard,
        ),
        postgresDeploymentWatchStore(db, scope, this.repositoryConnections),
        guard,
      );
      // Baseline source locks precede timeout enqueue. Finish pins precede watch intents.
      const durable = withDeploymentTimeout(
        withDeploymentWatchJobs(watch, guard),
        guard,
      );
      const probes = probeTransaction(
        signals,
        postgresProbeStore(db, scope),
        guard,
      );
      const cadence = withWatchCadence(
        durable,
        probes,
        postgresWatchCadenceStore(db, scope),
        guard,
      );
      return run({
        ...cadence,
        // Never spread signal/detection tokens over the deployment token port.
        watchIncidents: watchIncidentCorrelation(detection, guard),
        watchEvidence: {
          read: (entry, record, baseline) =>
            guard.operation(async () => {
              const projection = await readPostgresWatchEvidence(
                db,
                scope,
                entry,
                record,
                baseline,
              );
              const overlaps = await readPostgresWatchOverlaps(
                db,
                scope,
                record,
                projection.capturedAt,
              );
              return {
                ...evaluateWatchProjection(entry, record, baseline, projection),
                ...overlaps,
              };
            }),
        },
      });
    });
  }
}
