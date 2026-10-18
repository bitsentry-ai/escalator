import type {
  Clock,
  DeploymentEntry,
  DeploymentBaseline,
  DeploymentWatchRecord,
  WorkspaceId,
} from "../../src/contracts/index.js";
import { withDeploymentBaseline } from "../../src/application/deploy/baseline.js";
import {
  withDeploymentWatches,
  type DeploymentWatchTransaction,
} from "../../src/application/deploy/watch-persistence.js";
import type { TransactionGuard } from "../../src/application/ports/transaction-guard.js";
import type { PagingTransaction } from "../../src/application/paging/persistence.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import { MemoryDeploymentRepository } from "./memory-deployments.js";
import { baselineFromProjection } from "../../src/application/deploy/baseline-reader.js";
const copy = <T>(value: T): T => structuredClone(value);
/** Test-only physical-transaction adapter. Extensions are rolled back by the
 * foundation adapter, including errors a callback catches before returning.
 */
export class MemoryDeploymentWatchRepository {
  readonly base: MemoryDeploymentRepository;
  failWatchInsert = false;
  captureBaseline: ((entry: DeploymentEntry) => DeploymentBaseline) | undefined;
  constructor(clock?: Clock) {
    this.base = new MemoryDeploymentRepository(clock);
  }
  get configuration() {
    return this.base.configuration;
  }
  get work() {
    return this.base.work;
  }
  findTokenContext(hash: string) {
    return this.base.findTokenContext(hash);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: DeploymentWatchTransaction & PagingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withExtensions(scope, run);
  }
  withExtensions<T>(
    scope: WorkspaceId,
    run: (
      tx: DeploymentWatchTransaction & PagingTransaction,
      guard: TransactionGuard,
    ) => Promise<T>,
  ): Promise<T> {
    return this.base.withExtensions(scope, (tx, paging, extensions, guard) => {
      const baselines = (extensions.baselines ??= []) as DeploymentBaseline[];
      const watches = (extensions.watches ??= []) as DeploymentWatchRecord[];
      const baseline = withDeploymentBaseline(
        { ...paging, ...tx },
        {
          capture: async (entry) => {
            if (this.captureBaseline) return this.captureBaseline(entry);
            return baselineFromProjection(entry, {
              workspaceId: scope,
              serviceId: entry.deployment.serviceId,
              environmentId: entry.deployment.environmentId,
              capturedAt: await tx.currentTime(),
              inventoryComplete: true,
              streams: [],
            });
          },
          async get(targetId, deploymentId) {
            return copy(
              baselines.find(
                (row) =>
                  row.workspaceId === scope &&
                  row.targetId === targetId &&
                  row.deploymentId === deploymentId,
              ),
            );
          },
          async insert(value) {
            baselines.push(copy(value));
          },
        },
        guard,
      );
      return run(
        withDeploymentWatches(
          baseline,
          {
            async get(targetId, deploymentId) {
              return copy(
                watches.find(
                  (row) =>
                    row.workspaceId === scope &&
                    row.targetId === targetId &&
                    row.deploymentId === deploymentId,
                ),
              );
            },
            insert: async (value) => {
              if (
                watches.some(
                  (row) =>
                    row.workspaceId === scope &&
                    row.deploymentId === value.deploymentId,
                )
              )
                throw new PersistenceError("already_exists");
              watches.push(copy(value));
              if (this.failWatchInsert)
                throw new Error("Injected watch write failure");
            },
            async replace(value, expectedRevision) {
              const index = watches.findIndex(
                (row) =>
                  row.workspaceId === scope &&
                  row.deploymentId === value.deploymentId &&
                  row.revision === expectedRevision,
              );
              if (index < 0) return false;
              watches[index] = copy(value);
              return true;
            },
            incident: (id) => paging.incidents.get(id),
          },
          guard,
        ),
        guard,
      );
    });
  }
}
