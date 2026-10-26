import { z } from "zod";
import { opaqueIdSchema } from "../../contracts/index.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type { DeploymentWatchRepository } from "./watch-persistence.js";
import { deploymentWatchPayloadSchema } from "./watch-runtime.js";
import { compareCodeUnits } from "../../contracts/ordering.js";
const batchSize = 8;
export const watchCadenceBatchPayloadSchema =
  deploymentWatchPayloadSchema.extend({
    offset: z.number().int().min(0).max(128).multipleOf(batchSize).default(0),
  });
export const watchProbeCadencePayloadSchema =
  deploymentWatchPayloadSchema.extend({
    probeId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
  });
/** No probe/capacity mutations here: only bounded, idempotent fan-out over the
 * immutable baseline. Per-probe handlers acquire capacity before target/source.
 */
export class WatchCadenceCoordinator {
  constructor(private readonly repository: DeploymentWatchRepository) {}
  run(lease: WorkLease): Promise<WorkResult> {
    const hint = watchCadenceBatchPayloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const target = await tx.targets.get(hint.targetId);
      if (!target) throw new Error("Cadence target is missing");
      const watch = await tx.watches.get(target.id, hint.deploymentId);
      if (!watch) throw new Error("Cadence watch is missing");
      const baseline = await tx.baselines.get(target.id, hint.deploymentId);
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      const payload = watchCadenceBatchPayloadSchema.parse(claimed.payload);
      const suffix = payload.offset === 0 ? [] : [String(payload.offset)];
      if (
        claimed.queue !== "job" ||
        claimed.kind !== "deployment.watch-cadence" ||
        claimed.workspaceId !== tx.workspaceId ||
        claimed.id !==
          pagingWorkId(
            tx.workspaceId,
            "deployment.watch-cadence",
            target.id,
            watch.deploymentId,
            ...suffix,
          ) ||
        payload.targetId !== target.id ||
        payload.deploymentId !== watch.deploymentId ||
        payload.startedAt !== watch.startedAt
      )
        throw new Error("Invalid cadence batch claim");
      if (
        !baseline ||
        Date.parse(await tx.currentTime()) >= Date.parse(watch.endsAt)
      )
        return { state: "completed" };
      const probes = baseline.streams
        .filter((stream) => stream.kind === "probe")
        .sort((a, b) => compareCodeUnits(a.id, b.id));
      if (payload.offset > probes.length)
        throw new Error("Cadence batch exceeds captured inventory");
      for (const probe of probes.slice(
        payload.offset,
        payload.offset + batchSize,
      )) {
        const id = pagingWorkId(
          tx.workspaceId,
          "deployment.watch-probe-cadence",
          target.id,
          watch.deploymentId,
          probe.id,
        );
        await tx.work.enqueue("job", {
          id,
          kind: "deployment.watch-probe-cadence",
          idempotencyKey: id,
          dueAt: tx.now,
          priority: 75,
          payload: {
            targetId: target.id,
            deploymentId: watch.deploymentId,
            startedAt: watch.startedAt,
            probeId: probe.id,
            sourceId: probe.sourceId,
          },
        });
      }
      const offset = payload.offset + batchSize;
      if (offset < probes.length) {
        const id = pagingWorkId(
          tx.workspaceId,
          "deployment.watch-cadence",
          target.id,
          watch.deploymentId,
          String(offset),
        );
        await tx.work.enqueue("job", {
          id,
          kind: "deployment.watch-cadence",
          idempotencyKey: id,
          dueAt: tx.now,
          priority: 75,
          payload: {
            targetId: target.id,
            deploymentId: watch.deploymentId,
            startedAt: watch.startedAt,
            offset,
          },
        });
      }
      return { state: "completed" };
    });
  }
}
