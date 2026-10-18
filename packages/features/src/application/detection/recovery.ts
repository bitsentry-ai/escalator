import { z } from "zod";
import { opaqueIdSchema, type AlertGroup } from "../../contracts/index.js";
import { incidentRecoveryDeadline } from "../../domain/alerts/transition.js";
import type { WorkLease, WorkResult } from "../jobs/ports.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { resolvePageInTransaction } from "../paging/resolve.js";
import type { DetectionRepository, DetectionTransaction } from "./ports.js";
const payloadSchema = z.strictObject({
  groupKey: opaqueIdSchema,
  incidentId: opaqueIdSchema,
  revision: z.number().int().min(1),
});
export async function recoveryDeadline(
  tx: DetectionTransaction,
  incidentId: string,
): Promise<string | null> {
  let after: string | undefined;
  let deadline: string | null = null;
  do {
    const batch = await tx.detection.forIncident(incidentId, {
      limit: 100,
      after,
    });
    if (batch.items.length) {
      const next = incidentRecoveryDeadline(batch.items);
      if (!next) return null;
      if (!deadline || next > deadline) deadline = next;
    }
    after = batch.next ?? undefined;
  } while (after);
  return deadline;
}
export async function scheduleRecovery(
  tx: DetectionTransaction,
  group: AlertGroup,
  deadline: string | null,
): Promise<AlertGroup> {
  if (!deadline || !group.incidentId) return group;
  const revision = group.revision + 1;
  const id = pagingWorkId(
    tx.workspaceId,
    "signal-recovery",
    group.id,
    String(revision),
  );
  const next = { ...group, revision, recoveryJobId: id };
  if (!(await tx.detection.putGroup(next, group.revision)))
    throw new Error("Locked recovery revision changed");
  await tx.work.enqueue("job", {
    id,
    kind: "signal.recover",
    idempotencyKey: id,
    payload: { groupKey: group.id, incidentId: group.incidentId, revision },
    dueAt: deadline,
    priority: 100,
  });
  return next;
}
/** Re-check every contributor while holding the same group/page locks used by processing. */
export class SignalRecovery {
  constructor(private readonly repository: DetectionRepository) {}
  recover(lease: WorkLease): Promise<WorkResult> {
    const hint = payloadSchema.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const group = await tx.detection.lockGroup(hint.groupKey);
      await tx.pages.lock(
        pagingWorkId(tx.workspaceId, "page", hint.incidentId),
      );
      const claimed = await tx.work.lockClaim(lease);
      if (!claimed) return { state: "completed" };
      const payload = payloadSchema.parse(claimed.payload);
      if (
        claimed.queue !== "job" ||
        claimed.kind !== "signal.recover" ||
        payload.groupKey !== hint.groupKey ||
        payload.incidentId !== hint.incidentId ||
        claimed.id !==
          pagingWorkId(
            tx.workspaceId,
            "signal-recovery",
            payload.groupKey,
            String(payload.revision),
          )
      )
        throw new Error("Invalid recovery claim");
      if (
        !group ||
        group.incidentId !== payload.incidentId ||
        group.revision !== payload.revision ||
        group.recoveryJobId !== claimed.id
      )
        return { state: "completed" };
      const incident = await tx.incidents.get(payload.incidentId);
      if (!incident) throw new Error("Recovery incident is missing");
      if (!incident.resolvedAt) {
        const deadline = await recoveryDeadline(tx, incident.id);
        if (deadline) {
          const remaining =
            Date.parse(deadline) - Date.parse(await tx.currentTime());
          if (remaining > 0)
            return { state: "wait", delayMs: Math.min(3_600_000, remaining) };
          await resolvePageInTransaction(tx, incident.id, {
            kind: "system",
            component: "detection",
          });
        }
      }
      if (
        !(await tx.detection.putGroup(
          { ...group, revision: group.revision + 1, recoveryJobId: null },
          group.revision,
        ))
      )
        throw new Error("Locked recovery revision changed");
      return { state: "completed" };
    });
  }
}
