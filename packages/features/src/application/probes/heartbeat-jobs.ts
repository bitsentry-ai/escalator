import { z } from "zod";
import { opaqueIdSchema } from "../../contracts/identity.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import type { WorkLease } from "../jobs/ports.js";
import type { WorkHandlerResult } from "../jobs/runner.js";
import type { HeartbeatRepository } from "./heartbeat-ports.js";
import { heartbeatDeadlineId, missHeartbeat } from "./heartbeat.js";
import { recordSignal } from "../signals/record.js";
export const heartbeatDeadlinePayload = z.strictObject({
  probeId: opaqueIdSchema,
  configurationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  deadlineAt: utcTimestampSchema,
});
/** Claims are re-read after the source/configuration lock; an obsolete miss cannot race a ping. */
export class HeartbeatJobs {
  constructor(private readonly repository: HeartbeatRepository) {}
  async miss(lease: WorkLease): Promise<WorkHandlerResult> {
    const hint = heartbeatDeadlinePayload.parse(lease.payload);
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const probe = await tx.heartbeats.lock(hint.probeId);
      const claim = await tx.work.lockClaim(lease);
      if (!claim) return { state: "stale" };
      const payload = heartbeatDeadlinePayload.parse(claim.payload);
      if (
        claim.queue !== "job" ||
        claim.kind !== "heartbeat.deadline" ||
        payload.probeId !== hint.probeId ||
        claim.id !==
          heartbeatDeadlineId(
            tx.workspaceId,
            payload.probeId,
            payload.configurationVersion,
            payload.generation,
            payload.deadlineAt,
          )
      )
        throw new Error("Invalid heartbeat claim");
      if (
        !probe ||
        !probe.enabled ||
        probe.version !== payload.configurationVersion
      )
        return { state: "completed" };
      const current = await tx.heartbeats.state(probe.id);
      if (
        !current ||
        current.generation !== payload.generation ||
        current.deadlineJobId !== claim.id ||
        current.deadlineAt !== payload.deadlineAt
      )
        return { state: "completed" };
      const now = await tx.currentTime();
      const remaining = Date.parse(payload.deadlineAt) - Date.parse(now);
      // Strictly past the millisecond deadline keeps a later ping strictly newer than its miss signal.
      if (remaining >= 0)
        return { state: "wait", delayMs: Math.min(3600000, remaining + 1) };
      const source = await tx.sources.get(probe.sourceId);
      const service = await tx.services.get(probe.serviceId);
      if (
        !source ||
        source.kind !== "heartbeat" ||
        source.serviceId !== probe.serviceId ||
        source.environmentId !== probe.environmentId
      )
        throw new Error("Invalid heartbeat source");
      if (!source.enabled || !service?.enabled)
        return { state: "wait", delayMs: 60000 };
      const missed = missHeartbeat(probe, current, claim.id, now);
      if (!missed) return { state: "completed" };
      await tx.heartbeats.putState(missed);
      await recordSignal(tx, source, "internal-heartbeat", {
        version: 1,
        eventId: `heartbeat-miss:${claim.id}`,
        fingerprint: `heartbeat:${probe.id}`,
        observedAt: payload.deadlineAt,
        status: "active",
        severity: "high",
        title: `Heartbeat: ${probe.name}`,
        evidence: {
          summary: "Heartbeat deadline missed",
          attributes: [
            { name: "probeId", value: probe.id },
            { name: "generation", value: String(payload.generation) },
          ],
        },
      });
      return { state: "completed" };
    });
  }
}
