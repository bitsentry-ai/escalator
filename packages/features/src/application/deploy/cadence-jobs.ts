import { z } from "zod";
import {
  opaqueIdSchema,
  type Probe,
  type WatchCadenceReceipt,
  type WatchCadenceLease,
} from "../../contracts/index.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import type { WorkHandlers } from "../jobs/scheduler.js";
import type { WorkHandler } from "../jobs/runner.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import {
  assertProbeCapacity,
  ProbeCapacityError,
  probeLimitsSchema,
  type ProbeLimits,
} from "../probes/capacity.js";
import { scheduleProbe } from "../probes/execute.js";
import type { ProbeTransaction } from "../probes/ports.js";
import { planWatchCadence, planWatchCadenceRestore } from "./cadence.js";
import type {
  WatchCadenceRepository,
  WatchCadenceTransaction,
} from "./cadence-persistence.js";
import {
  WatchCadenceCoordinator,
  watchProbeCadencePayloadSchema,
} from "./cadence-coordinator.js";
const restorePayload = z.strictObject({
  targetId: opaqueIdSchema,
  probeId: opaqueIdSchema,
  generationId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const actor = {
  kind: "system",
  component: "deployment-watch-cadence",
} as const;
export const deploymentWatchCadenceLane = [
  "deployment.watch-cadence",
  "deployment.watch-probe-cadence",
  "deployment.watch-cadence-restore",
] as const;
/** Each lease revision gets its own restore job, so a join re-arms restoration
 * even after an earlier restore job failed terminally.
 */
const restoreJobId = (
  value: Pick<
    WatchCadenceLease,
    "workspaceId" | "probeId" | "generationId" | "revision"
  >,
) =>
  pagingWorkId(
    value.workspaceId,
    "deployment.watch-cadence-restore",
    value.probeId,
    value.generationId,
    String(value.revision),
  );
/** Preserve the existing probe/source version and schedule protocol, including
 * configuration history recording by each host's probe store. No provider I/O.
 */
async function saveProbe(tx: ProbeTransaction, probe: Probe, expected: number) {
  const source = await tx.sources.get(probe.sourceId);
  if (!source) throw new Error("Cadence source is missing");
  if (!(await tx.probes.put(probe, expected)))
    throw new Error("Locked cadence probe changed");
  if (
    !(await tx.sources.replace(
      { ...source, version: source.version + 1, updatedAt: tx.now },
      source.version,
    ))
  )
    throw new Error("Locked cadence source changed");
  await scheduleProbe(tx, probe, tx.now);
}
async function record(tx: WatchCadenceTransaction, value: WatchCadenceReceipt) {
  await tx.cadence.record(value);
  await tx.audit.append({
    id: pagingWorkId(
      tx.workspaceId,
      "watch-cadence-application",
      value.deploymentId,
      value.probeId,
    ),
    workspaceId: tx.workspaceId,
    actor,
    action:
      value.decision === "tightened" || value.decision === "joined"
        ? "deployment.watch_cadence_applied"
        : "deployment.watch_cadence_skipped",
    subjectType: "deployment",
    subjectId: value.deploymentId,
    recordedAt: tx.now,
    metadata: {
      targetId: value.targetId,
      probeId: value.probeId,
      decision: value.decision,
      generationId: value.generationId,
      appliedProbeVersion: value.appliedProbeVersion,
    },
  });
}
type CadenceTransaction = Parameters<
  Parameters<WatchCadenceRepository["transaction"]>[1]
>[0];
/** Reads capacity, then the target, then the source and probe, before the work fence. */
async function loadCadenceProbe(
  tx: CadenceTransaction,
  hint: z.infer<typeof watchProbeCadencePayloadSchema>,
) {
  const previous = await tx.cadence.receipt(
    hint.targetId,
    hint.deploymentId,
    hint.probeId,
  );
  const watch = await tx.watches.get(hint.targetId, hint.deploymentId);
  const baseline = await tx.baselines.get(hint.targetId, hint.deploymentId);
  const probe = await tx.probeContext.probes.lock(hint.probeId);
  const captured = baseline?.streams.find(
    (row) => row.kind === "probe" && row.id === hint.probeId,
  );
  if (!watch || !probe || !captured)
    throw new Error("Cadence captured probe is missing");
  const current = await tx.cadence.lease(hint.targetId, probe.id);
  return { previous, watch, probe, captured, current };
}
async function removeSupersededLease(
  tx: CadenceTransaction,
  targetId: string,
  probeId: string,
  current: { generationId: string; revision: number },
): Promise<void> {
  if (
    !(await tx.cadence.removeLease(
      targetId,
      probeId,
      current.generationId,
      current.revision,
    ))
  )
    throw new Error("Locked cadence ownership changed");
}
function assertCadenceClaim(
  workspaceId: WorkspaceId,
  claimed: {
    workspaceId: string;
    queue: string;
    kind: string;
    id: string;
    payload: unknown;
  },
  targetId: string,
  watch: { deploymentId: string; startedAt: string },
  probe: { id: string; sourceId: string },
): void {
  const payload = watchProbeCadencePayloadSchema.parse(claimed.payload);
  if (
    claimed.workspaceId !== workspaceId ||
    claimed.queue !== "job" ||
    claimed.kind !== "deployment.watch-probe-cadence" ||
    claimed.id !==
      pagingWorkId(
        workspaceId,
        "deployment.watch-probe-cadence",
        targetId,
        watch.deploymentId,
        probe.id,
      ) ||
    payload.targetId !== targetId ||
    payload.deploymentId !== watch.deploymentId ||
    payload.startedAt !== watch.startedAt ||
    payload.probeId !== probe.id ||
    payload.sourceId !== probe.sourceId
  )
    throw new Error("Invalid probe cadence claim");
}
export class WatchProbeCadenceJobs {
  private readonly limits: ProbeLimits;
  constructor(
    private readonly repository: WatchCadenceRepository,
    limits: ProbeLimits,
  ) {
    this.limits = probeLimitsSchema.parse(limits);
  }
  tighten(lease: WorkLease): Promise<WorkResult> {
    const hint = watchProbeCadencePayloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const { previous, watch, probe, captured, current } =
        await loadCadenceProbe(tx, hint);
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      assertCadenceClaim(tx.workspaceId, claimed, hint.targetId, watch, probe);
      if (previous) return { state: "completed" };
      const receipt: WatchCadenceReceipt = {
        workspaceId: tx.workspaceId,
        targetId: watch.targetId,
        deploymentId: watch.deploymentId,
        probeId: probe.id,
        sourceId: probe.sourceId,
        serviceId: probe.serviceId,
        environmentId: probe.environmentId,
        recordedAt: tx.now,
        decision: "expired",
        generationId: null,
        appliedProbeVersion: null,
      };
      if (Date.parse(await tx.currentTime()) >= Date.parse(watch.endsAt)) {
        await record(tx, receipt);
        return { state: "completed" };
      }
      const plan = planWatchCadence(watch, captured, probe, current, tx.now);
      if (plan.state === "skip") {
        if (current && plan.decision === "superseded")
          await removeSupersededLease(tx, watch.targetId, probe.id, current);
        await record(tx, { ...receipt, decision: plan.decision });
        return { state: "completed" };
      }
      // Extending an existing faster interval needs fresh capacity admission too:
      // deployment limits may have been reduced since the original watch.
      try {
        await assertProbeCapacity(
          tx.probeContext,
          plan.state === "tighten" ? plan.probe : probe,
          this.limits,
        );
      } catch (error) {
        if (!(error instanceof ProbeCapacityError)) throw error;
        await record(tx, { ...receipt, decision: "capacity_limited" });
        return { state: "completed" };
      }
      if (plan.state === "tighten")
        await saveProbe(tx.probeContext, plan.probe, probe.version);
      if (
        !(await tx.cadence.putLease(
          watch.deploymentId,
          plan.lease,
          current?.revision ?? null,
        ))
      )
        throw new Error("Locked cadence ownership changed");
      const id = restoreJobId(plan.lease);
      await tx.work.enqueue("job", {
        id,
        kind: "deployment.watch-cadence-restore",
        idempotencyKey: id,
        dueAt: plan.lease.restoreAt,
        priority: 85,
        payload: {
          targetId: watch.targetId,
          probeId: probe.id,
          generationId: plan.lease.generationId,
          revision: plan.lease.revision,
        },
      });
      await record(tx, {
        ...receipt,
        decision: plan.state === "tighten" ? "tightened" : "joined",
        generationId: plan.lease.generationId,
        appliedProbeVersion: plan.lease.appliedProbeVersion,
      });
      return { state: "completed" };
    });
  }
  restore(lease: WorkLease): Promise<WorkResult> {
    const hint = restorePayload.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const current = await tx.cadence.lease(hint.targetId, hint.probeId);
      const probe = await tx.probeContext.probes.lock(hint.probeId);
      if (!probe) throw new Error("Cadence restoration probe is missing");
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      const payload = restorePayload.parse(claimed.payload);
      if (
        claimed.workspaceId !== tx.workspaceId ||
        claimed.queue !== "job" ||
        claimed.kind !== "deployment.watch-cadence-restore" ||
        claimed.id !==
          restoreJobId({ ...payload, workspaceId: tx.workspaceId }) ||
        payload.targetId !== hint.targetId ||
        payload.probeId !== probe.id
      )
        throw new Error("Invalid cadence restoration claim");
      // Every lease revision enqueues its own restore job in the same transaction.
      if (
        !current ||
        current.generationId !== payload.generationId ||
        current.revision !== payload.revision
      )
        return { state: "completed" };
      const plan = planWatchCadenceRestore(current, probe, tx.now);
      if (plan.state === "wait")
        return {
          state: "wait",
          delayMs: Math.max(
            1,
            Math.min(
              60000,
              Date.parse(plan.dueAt) - Date.parse(await tx.currentTime()),
            ),
          ),
        };
      if (plan.state === "restore")
        await saveProbe(tx.probeContext, plan.probe, probe.version);
      if (
        !(await tx.cadence.removeLease(
          hint.targetId,
          probe.id,
          current.generationId,
          current.revision,
        ))
      )
        throw new Error("Locked cadence ownership changed");
      await tx.audit.append({
        id: pagingWorkId(
          tx.workspaceId,
          "watch-cadence-restored",
          probe.id,
          current.generationId,
        ),
        workspaceId: tx.workspaceId,
        actor,
        action:
          plan.state === "restore"
            ? "deployment.watch_cadence_restored"
            : "deployment.watch_cadence_superseded",
        subjectType: "probe",
        subjectId: probe.id,
        recordedAt: tx.now,
        metadata: {
          targetId: current.targetId,
          generationId: current.generationId,
          decision: plan.state,
          probeVersion:
            plan.state === "restore" ? plan.probe.version : probe.version,
          intervalSeconds:
            plan.state === "restore"
              ? plan.probe.intervalSeconds
              : probe.intervalSeconds,
        },
      });
      return { state: "completed" };
    });
  }
}
export function withWatchCadenceHandlers(
  handlers: WorkHandlers,
  repository: WatchCadenceRepository,
  limits: ProbeLimits,
): WorkHandlers {
  if (deploymentWatchCadenceLane.some((kind) => handlers.job.has(kind)))
    throw new Error("Watch cadence handler already registered");
  const coordinator = new WatchCadenceCoordinator(repository),
    probes = new WatchProbeCadenceJobs(repository, limits);
  return {
    job: new Map<string, WorkHandler>([
      ...handlers.job,
      ["deployment.watch-cadence", (lease) => coordinator.run(lease)],
      ["deployment.watch-probe-cadence", (lease) => probes.tighten(lease)],
      ["deployment.watch-cadence-restore", (lease) => probes.restore(lease)],
    ]),
    outbox: handlers.outbox,
  };
}
