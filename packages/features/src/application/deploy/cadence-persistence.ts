import {
  opaqueIdSchema,
  watchCadenceLeaseSchema,
  watchCadenceReceiptSchema,
  deploymentWatchProbeIntervalSeconds,
  type WatchCadenceLease,
  type WatchCadenceReceipt,
  type WorkspaceId,
  type Probe,
} from "../../contracts/index.js";
import type { ProbeTransaction } from "../probes/ports.js";
import type { DeploymentWatchTransaction } from "./watch-persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
export interface WatchCadenceStore {
  receipt(
    deploymentId: string,
    probeId: string,
  ): Promise<WatchCadenceReceipt | undefined>;
  insertReceipt(value: WatchCadenceReceipt): Promise<void>;
  lease(probeId: string): Promise<WatchCadenceLease | undefined>;
  putLease(
    value: WatchCadenceLease,
    expectedRevision: number | null,
  ): Promise<boolean>;
  removeLease(
    probeId: string,
    generationId: string,
    expectedRevision: number,
  ): Promise<boolean>;
}
export interface WatchCadenceTransaction extends DeploymentWatchTransaction {
  /** Namespaced to preserve the distinct signal-ingress and deployment token ports. */
  probeContext: ProbeTransaction;
  cadence: {
    receipt(
      targetId: string,
      deploymentId: string,
      probeId: string,
    ): Promise<WatchCadenceReceipt | undefined>;
    record(value: WatchCadenceReceipt): Promise<void>;
    lease(
      targetId: string,
      probeId: string,
    ): Promise<WatchCadenceLease | undefined>;
    putLease(
      deploymentId: string,
      value: WatchCadenceLease,
      expectedRevision: number | null,
    ): Promise<boolean>;
    removeLease(
      targetId: string,
      probeId: string,
      generationId: string,
      expectedRevision: number,
    ): Promise<boolean>;
  };
}
export interface WatchCadenceRepository {
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: WatchCadenceTransaction) => Promise<T>,
  ): Promise<T>;
}
/** All primitives use the same scoped physical transaction. Capacity precedes
 * target/source/probe locks; the probe row serializes its lease and receipts.
 * No provider I/O. Runtime must fence its work claim before calling writers.
 */
export function withWatchCadence<Tx extends DeploymentWatchTransaction>(
  base: Tx,
  probes: ProbeTransaction,
  store: WatchCadenceStore,
  guard: TransactionGuard,
): Tx & WatchCadenceTransaction {
  if (probes.workspaceId !== base.workspaceId || probes.now !== base.now)
    throw new PersistenceError("scope_violation");
  async function probeOwner(targetId: string, probeId: string) {
    opaqueIdSchema.parse(targetId);
    opaqueIdSchema.parse(probeId);
    await probes.probes.lockCapacity();
    const target = await base.targets.get(targetId);
    if (!target) throw new PersistenceError("not_found");
    const probe = await probes.probes.lock(probeId);
    if (!probe) throw new PersistenceError("not_found");
    if (
      probe.workspaceId !== base.workspaceId ||
      probe.serviceId !== target.serviceId ||
      probe.environmentId !== target.environmentId
    )
      throw new PersistenceError("scope_violation");
    return probe;
  }
  async function owner(
    targetId: string,
    deploymentId: string,
    probeId: string,
  ) {
    // probeOwner locks capacity and target before its source. Subsequent target
    // lookups only reacquire that held lock, never introduce a reversed order.
    const probe = await probeOwner(targetId, probeId);
    const watch = await base.watches.get(
      targetId,
      opaqueIdSchema.parse(deploymentId),
    );
    const baseline = await base.baselines.get(targetId, deploymentId);
    const captured = baseline?.streams.find(
      (row) => row.kind === "probe" && row.id === probe.id,
    );
    if (!watch || !captured || captured.sourceId !== probe.sourceId)
      throw new PersistenceError("scope_violation");
    return { probe, watch };
  }
  function bound(
    value: WatchCadenceLease | WatchCadenceReceipt,
    targetId: string,
    probe: Probe,
  ) {
    if (
      value.workspaceId !== base.workspaceId ||
      value.targetId !== targetId ||
      value.probeId !== probe.id ||
      value.sourceId !== probe.sourceId ||
      value.serviceId !== probe.serviceId ||
      value.environmentId !== probe.environmentId
    )
      throw new PersistenceError("scope_violation");
  }
  function revision(value: number) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError("Invalid cadence revision");
  }
  async function lease(targetId: string, probe: Probe) {
    const raw = await store.lease(probe.id);
    if (!raw) return undefined;
    const value = watchCadenceLeaseSchema.parse(raw);
    bound(value, targetId, probe);
    return value;
  }
  return {
    ...base,
    probeContext: probes,
    cadence: {
      receipt: (targetId, deploymentId, probeId) =>
        guard.operation(async () => {
          const { probe } = await owner(targetId, deploymentId, probeId);
          const raw = await store.receipt(deploymentId, probeId);
          if (!raw) return undefined;
          const value = watchCadenceReceiptSchema.parse(raw);
          bound(value, targetId, probe);
          if (value.deploymentId !== deploymentId)
            throw new PersistenceError("scope_violation");
          return value;
        }),
      record: (raw) =>
        guard.operation(async () => {
          const value = watchCadenceReceiptSchema.parse(raw);
          const { probe } = await owner(
            value.targetId,
            value.deploymentId,
            value.probeId,
          );
          bound(value, value.targetId, probe);
          if (value.recordedAt !== base.now)
            throw new RangeError("Cadence receipt must use transaction time");
          const prior = await store.receipt(value.deploymentId, value.probeId);
          if (prior) {
            const parsed = watchCadenceReceiptSchema.parse(prior);
            bound(parsed, value.targetId, probe);
            if (JSON.stringify(parsed) !== JSON.stringify(value))
              throw new PersistenceError("already_exists");
            return;
          }
          if (value.generationId !== null) {
            const current = await lease(value.targetId, probe);
            if (
              !current ||
              current.generationId !== value.generationId ||
              current.appliedProbeVersion !== value.appliedProbeVersion ||
              probe.version !== value.appliedProbeVersion
            )
              throw new PersistenceError("scope_violation");
          }
          await store.insertReceipt(value);
        }),
      lease: (targetId, probeId) =>
        guard.operation(async () =>
          lease(targetId, await probeOwner(targetId, probeId)),
        ),
      putLease: (deploymentId, raw, expected) =>
        guard.operation(async () => {
          const value = watchCadenceLeaseSchema.parse(raw);
          const { probe, watch } = await owner(
            value.targetId,
            deploymentId,
            value.probeId,
          );
          bound(value, value.targetId, probe);
          if (expected !== null) revision(expected);
          if (value.revision !== (expected ?? 0) + 1)
            throw new RangeError("Invalid cadence revision");
          if (
            !probe.enabled ||
            probe.intervalSeconds !== deploymentWatchProbeIntervalSeconds ||
            probe.version !== value.appliedProbeVersion
          )
            throw new PersistenceError("scope_violation");
          if (Date.parse(await base.currentTime()) >= Date.parse(watch.endsAt))
            throw new RangeError("Cadence watch expired");
          const current = await lease(value.targetId, probe);
          if ((current?.revision ?? null) !== expected) return false;
          if (!current) {
            if (
              value.generationDeploymentId !== deploymentId ||
              value.createdAt !== base.now ||
              value.restoreAt !== watch.endsAt ||
              value.generationId !==
                pagingWorkId(
                  base.workspaceId,
                  "watch-cadence-lease",
                  deploymentId,
                  probe.id,
                )
            )
              throw new PersistenceError("scope_violation");
          } else {
            for (const key of [
              "generationId",
              "generationDeploymentId",
              "createdAt",
              "originalIntervalSeconds",
              "appliedProbeVersion",
            ] as const)
              if (value[key] !== current[key])
                throw new PersistenceError("scope_violation");
            if (
              Date.parse(value.restoreAt) !==
              Math.max(Date.parse(current.restoreAt), Date.parse(watch.endsAt))
            )
              throw new RangeError("Invalid cadence extension");
          }
          return store.putLease(value, expected);
        }),
      removeLease: (targetId, probeId, generationId, expected) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(generationId);
          revision(expected);
          const current = await lease(
            targetId,
            await probeOwner(targetId, probeId),
          );
          if (
            !current ||
            current.generationId !== generationId ||
            current.revision !== expected
          )
            return false;
          return store.removeLease(probeId, generationId, expected);
        }),
    },
  };
}
