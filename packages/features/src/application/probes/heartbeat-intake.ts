import { createHash } from "node:crypto";
import {
  heartbeatPingSchema,
  type HeartbeatPing,
  type HeartbeatState,
} from "../../contracts/heartbeat.js";
import { opaqueIdSchema, type WorkspaceId } from "../../contracts/identity.js";
import type {
  HeartbeatRepository,
  HeartbeatTransaction,
} from "./heartbeat-ports.js";
import { acceptHeartbeat, HeartbeatError } from "./heartbeat.js";
import { heartbeatReceiptId } from "./heartbeat-transaction.js";
import { recordSignal } from "../signals/record.js";
export class HeartbeatIngressError extends Error {
  constructor(readonly code: "invalid_token" | "invalid_input" | "stale_ping") {
    super(code);
  }
}
export function heartbeatTokenHash(token: string): string {
  if (!/^ehb_[A-Za-z0-9_-]{43}$/.test(token))
    throw new HeartbeatIngressError("invalid_token");
  return createHash("sha256").update(token).digest("hex");
}
/** Configuration/ping transactions share the same version-bound absolute deadline intent. */
export async function writeHeartbeatDeadline(
  tx: HeartbeatTransaction,
  value: HeartbeatState,
  old?: HeartbeatState,
): Promise<void> {
  if (old?.deadlineJobId && old.deadlineJobId !== value.deadlineJobId)
    await tx.work.cancel("job", [old.deadlineJobId]);
  if (value.deadlineJobId && value.deadlineAt)
    await tx.work.enqueue("job", {
      id: value.deadlineJobId,
      kind: "heartbeat.deadline",
      idempotencyKey: value.deadlineJobId,
      dueAt: value.deadlineAt,
      payload: {
        probeId: value.probeId,
        configurationVersion: value.configurationVersion,
        generation: value.generation,
        deadlineAt: value.deadlineAt,
      },
    });
}
export class HeartbeatIntake {
  constructor(
    private readonly repository: HeartbeatRepository,
    private readonly allowed: (scope: WorkspaceId) => boolean,
  ) {}
  async accept(probeId: string, token: string, raw: HeartbeatPing) {
    const hash = heartbeatTokenHash(token);
    let input: HeartbeatPing;
    try {
      opaqueIdSchema.parse(probeId);
      input = heartbeatPingSchema.parse(raw);
    } catch {
      throw new HeartbeatIngressError("invalid_input");
    }
    const context = await this.repository.findGrantContext(hash);
    if (
      !context ||
      context.probeId !== probeId ||
      !this.allowed(context.workspaceId)
    )
      throw new HeartbeatIngressError("invalid_token");
    try {
      return await this.repository.transaction(
        context.workspaceId,
        async (tx) => {
          const probe = await tx.heartbeats.lock(probeId);
          const grant = await tx.heartbeats.grantByHash(hash);
          const source = probe
            ? await tx.sources.get(probe.sourceId)
            : undefined;
          const service = probe
            ? await tx.services.get(probe.serviceId)
            : undefined;
          const now = await tx.currentTime();
          if (
            !probe?.enabled ||
            !source?.enabled ||
            !service?.enabled ||
            !grant ||
            grant.probeId !== probe.id ||
            grant.revokedAt !== null ||
            Date.parse(grant.expiresAt) <= Date.parse(now)
          )
            throw new HeartbeatIngressError("invalid_token");
          const receipt = await tx.heartbeats.receipt(probe.id, input.eventId);
          if (receipt)
            return {
              state: "duplicate" as const,
              acceptedAt: receipt.acceptedAt,
              deadlineAt: receipt.deadlineAt,
            };
          const old = await tx.heartbeats.state(probe.id);
          if (!old) throw new HeartbeatError("invalid_state");
          const next = acceptHeartbeat(probe, old, input, now);
          const id = heartbeatReceiptId(
            tx.workspaceId,
            probe.id,
            input.eventId,
          );
          await tx.heartbeats.insertReceipt({
            id,
            workspaceId: tx.workspaceId,
            probeId: probe.id,
            eventId: input.eventId,
            grantId: grant.id,
            observedAt: input.observedAt,
            acceptedAt: now,
            generation: next.generation,
            deadlineAt: next.deadlineAt!,
          });
          await tx.heartbeats.putState(next);
          await writeHeartbeatDeadline(tx, next, old);
          if (old.missedAt !== null)
            await recordSignal(tx, source, grant.id, {
              version: 1,
              eventId: `heartbeat-ping:${id}`,
              fingerprint: `heartbeat:${probe.id}`,
              observedAt: now,
              status: "recovered",
              severity: "high",
              title: `Heartbeat: ${probe.name}`,
              evidence: {
                summary: "Heartbeat received",
                attributes: [
                  { name: "probeId", value: probe.id },
                  { name: "generation", value: String(next.generation) },
                ],
              },
            });
          await tx.audit.append({
            id: `heartbeat.ping:${id}`,
            workspaceId: tx.workspaceId,
            actor: { kind: "system", component: "heartbeat-ingress" },
            action: "heartbeat.received",
            subjectType: "heartbeat",
            subjectId: probe.id,
            recordedAt: tx.now,
            metadata: {
              receiptId: id,
              grantId: grant.id,
              generation: next.generation,
              acceptedAt: now,
            },
          });
          return {
            state: "accepted" as const,
            acceptedAt: now,
            deadlineAt: next.deadlineAt!,
          };
        },
      );
    } catch (error) {
      if (error instanceof HeartbeatError && error.code === "stale_ping")
        throw new HeartbeatIngressError("stale_ping");
      if (error instanceof HeartbeatError && error.code === "disabled")
        throw new HeartbeatIngressError("invalid_token");
      throw error;
    }
  }
}
