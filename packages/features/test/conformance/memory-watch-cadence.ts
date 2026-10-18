import type {
  Clock,
  WorkspaceId,
  WatchCadenceLease,
  WatchCadenceReceipt,
} from "../../src/contracts/index.js";
import {
  withWatchCadence,
  type WatchCadenceTransaction,
  type WatchCadenceStore,
} from "../../src/application/deploy/cadence-persistence.js";
import { MemoryDeploymentWatchRepository } from "./memory-deployment-watches.js";
import { MemoryProbeRepository } from "./memory-probes.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
const copy = <T>(value: T): T => structuredClone(value);
/** One physical foundation snapshot for probes, deployment watches and cadence state. */
export class MemoryWatchCadenceRepository {
  readonly watches: MemoryDeploymentWatchRepository;
  private readonly probes: MemoryProbeRepository;
  failReceipt = false;
  constructor(clock: Clock) {
    this.watches = new MemoryDeploymentWatchRepository(clock);
    this.probes = new MemoryProbeRepository(() => clock.now());
  }
  get configuration() {
    return this.watches.configuration;
  }
  get work() {
    return this.watches.work;
  }
  findTokenContext(hash: string) {
    return this.watches.findTokenContext(hash);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: WatchCadenceTransaction) => Promise<T>,
  ): Promise<T> {
    return this.watches.withExtensions(scope, (watch, guard, extensions) => {
      const leases = (extensions.cadenceLeases ??= []) as WatchCadenceLease[];
      const receipts = (extensions.cadenceReceipts ??=
        []) as WatchCadenceReceipt[];
      const store: WatchCadenceStore = {
        async receipt(deploymentId, probeId) {
          return copy(
            receipts.find(
              (row) =>
                row.workspaceId === scope &&
                row.deploymentId === deploymentId &&
                row.probeId === probeId,
            ),
          );
        },
        insertReceipt: async (value) => {
          if (
            receipts.some(
              (row) =>
                row.workspaceId === scope &&
                row.deploymentId === value.deploymentId &&
                row.probeId === value.probeId,
            )
          )
            throw new PersistenceError("already_exists");
          receipts.push(copy(value));
          if (this.failReceipt)
            throw new Error("Injected cadence receipt failure");
        },
        async lease(probeId) {
          return copy(
            leases.find(
              (row) => row.workspaceId === scope && row.probeId === probeId,
            ),
          );
        },
        async putLease(value, expected) {
          const index = leases.findIndex(
            (row) => row.workspaceId === scope && row.probeId === value.probeId,
          );
          if ((index < 0 ? null : leases[index].revision) !== expected)
            return false;
          if (index < 0) leases.push(copy(value));
          else leases[index] = copy(value);
          return true;
        },
        async removeLease(probeId, generationId, expected) {
          const index = leases.findIndex(
            (row) =>
              row.workspaceId === scope &&
              row.probeId === probeId &&
              row.generationId === generationId &&
              row.revision === expected,
          );
          if (index < 0) return false;
          leases.splice(index, 1);
          return true;
        },
      };
      return run(
        withWatchCadence(
          watch,
          this.probes.decorate(watch, extensions, guard),
          store,
          guard,
        ),
      );
    });
  }
}
