import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  type Probe,
  type SignalSource,
} from "../../contracts/index.js";
import { probeResultSchema } from "../../contracts/probes.js";
import { observeProbe } from "../../domain/probes/observe.js";
import type { WorkLease } from "../jobs/ports.js";
import type { WorkHandlerResult } from "../jobs/runner.js";
import type { ProbeRepository, ProbeTransaction } from "./ports.js";
import type { HttpProbeRunner, ProbeObservation } from "./http-runner.js";
import { probeJobId, nextProbeDueAt } from "./schedule.js";
import { recordSignal } from "../signals/record.js";
export const probeJobPayloadSchema = z.strictObject({
  probeId: opaqueIdSchema,
  probeVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  dueAt: utcTimestampSchema,
  secretIds: z.array(opaqueIdSchema).max(1),
});
/** Called inside the probe/source transaction; payloads contain IDs only. */
export async function scheduleProbe(
  tx: ProbeTransaction,
  probe: Probe,
  dueAt: string,
): Promise<void> {
  return writeSchedule(tx, probe, dueAt, true);
}
async function writeSchedule(
  tx: ProbeTransaction,
  probe: Probe,
  dueAt: string,
  cancelPrevious: boolean,
): Promise<void> {
  const previous = await tx.probes.schedule(probe.id);
  const jobId = probe.enabled
    ? probeJobId(tx.workspaceId, probe.id, probe.version, dueAt)
    : null;
  if (cancelPrevious && previous?.jobId && previous.jobId !== jobId)
    await tx.work.cancel("job", [previous.jobId]);
  if (jobId)
    await tx.work.enqueue("job", {
      id: jobId,
      kind: "probe.execute",
      idempotencyKey: jobId,
      dueAt,
      payload: {
        probeId: probe.id,
        probeVersion: probe.version,
        dueAt,
        secretIds: probe.config.authSecretId ? [probe.config.authSecretId] : [],
      },
    });
  await tx.probes.putSchedule({
    probeId: probe.id,
    workspaceId: tx.workspaceId,
    probeVersion: probe.version,
    jobId,
    dueAt: jobId ? dueAt : null,
  });
}
type Ready = {
  probe: Probe;
  source: SignalSource;
  dueAt: string;
  available: boolean;
};
/** A run commits its observation and successor before lease settlement; retries see that receipt. */
export class ProbeExecutionJobs {
  constructor(
    private readonly repository: ProbeRepository,
    private readonly runner: Pick<HttpProbeRunner, "run">,
  ) {}
  private async prepare(
    tx: ProbeTransaction,
    lease: WorkLease,
  ): Promise<Ready | { result: WorkHandlerResult }> {
    const hint = probeJobPayloadSchema.parse(lease.payload);
    const probe = await tx.probes.lock(hint.probeId);
    const claimed = await tx.work.lockClaim(lease);
    if (!claimed) return { result: { state: "stale" } };
    const payload = probeJobPayloadSchema.parse(claimed.payload);
    if (
      claimed.queue !== "job" ||
      claimed.kind !== "probe.execute" ||
      payload.probeId !== hint.probeId ||
      claimed.id !==
        probeJobId(
          tx.workspaceId,
          payload.probeId,
          payload.probeVersion,
          payload.dueAt,
        )
    )
      throw new Error("Invalid probe claim");
    if (await tx.probes.result(claimed.id))
      return { result: { state: "completed" } };
    if (!probe) throw new Error("Probe job references a missing configuration");
    if (!probe.enabled || probe.version !== payload.probeVersion)
      return { result: { state: "completed" } };
    const schedule = await tx.probes.schedule(probe.id);
    if (!schedule) throw new Error("Probe schedule is missing");
    if (
      schedule.jobId !== claimed.id ||
      schedule.probeVersion !== probe.version ||
      schedule.dueAt !== payload.dueAt
    )
      return { result: { state: "completed" } };
    const expected = probe.config.authSecretId
      ? [probe.config.authSecretId]
      : [];
    if (JSON.stringify(payload.secretIds) !== JSON.stringify(expected))
      throw new Error("Probe secret binding differs");
    const remaining =
      Date.parse(payload.dueAt) - Date.parse(await tx.currentTime());
    if (remaining > 0)
      return {
        result: { state: "wait", delayMs: Math.min(3600000, remaining) },
      };
    const source = await tx.sources.get(probe.sourceId);
    if (
      !source ||
      source.kind !== "probe" ||
      source.serviceId !== probe.serviceId ||
      source.environmentId !== probe.environmentId
    )
      throw new Error("Probe source differs");
    const service = await tx.services.get(probe.serviceId);
    return {
      probe,
      source,
      dueAt: payload.dueAt,
      available: source.enabled && !!service?.enabled,
    };
  }
  async execute(
    lease: WorkLease,
    signal: AbortSignal,
  ): Promise<WorkHandlerResult> {
    if (signal.aborted) return { state: "stale" };
    const prepared = await this.repository.transaction(
      lease.workspaceId,
      (tx) => this.prepare(tx, lease),
    );
    if ("result" in prepared) return prepared.result;
    const unavailable: ProbeObservation = {
      outcome: "unknown",
      reason: "invalid_configuration",
      statusCode: null,
      durationMs: 0,
    };
    const observation = prepared.available
      ? await this.runner.run(prepared.probe.config, {
          workspaceId: lease.workspaceId,
          workId: lease.id,
          claimToken: lease.token,
          signal,
        })
      : unavailable;
    if (signal.aborted) return { state: "stale" };
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const current = await this.prepare(tx, lease);
      if ("result" in current) return current.result;
      if (signal.aborted) return { state: "stale" };
      const verdict =
        current.available && current.source.version === prepared.source.version
          ? observation
          : unavailable;
      const result = probeResultSchema.parse({
        ...verdict,
        id: lease.id,
        workspaceId: tx.workspaceId,
        probeId: current.probe.id,
        probeVersion: current.probe.version,
        observedAt: tx.now,
      });
      await tx.probes.recordResult(result);
      const decision = observeProbe(
        current.probe,
        await tx.probes.state(current.probe.id),
        result,
      );
      if ("state" in decision) {
        await tx.probes.putState(decision.state);
        if (decision.signal)
          await recordSignal(tx, current.source, "internal-probe", {
            version: 1,
            eventId: result.id,
            fingerprint: `probe:${current.probe.id}`,
            observedAt: result.observedAt,
            status: decision.signal,
            severity: current.probe.critical ? "critical" : "high",
            title: `Probe: ${current.probe.name}`,
            evidence: {
              summary: result.reason,
              attributes: [
                { name: "probeId", value: current.probe.id },
                { name: "probeVersion", value: String(current.probe.version) },
              ],
            },
          });
      }
      const next = nextProbeDueAt(
        current.dueAt,
        await tx.currentTime(),
        current.probe.intervalSeconds,
      );
      // The current claimed job must remain live until its receipt is committed and the runner settles it.
      // scheduleProbe normally cancels obsolete edits; completion advances explicitly instead.
      await writeSchedule(tx, current.probe, next, false);
      await tx.audit.append({
        id: `probe.observed:${result.id.slice(14)}`,
        workspaceId: tx.workspaceId,
        actor: { kind: "system", component: "probes" },
        action: "probe.observed",
        subjectType: "probe",
        subjectId: current.probe.id,
        recordedAt: tx.now,
        metadata: {
          resultId: result.id,
          outcome: result.outcome,
          reason: result.reason,
          scheduledAt: current.dueAt,
          skippedSlots: Math.max(
            0,
            (Date.parse(next) - Date.parse(current.dueAt)) /
              (current.probe.intervalSeconds * 1000) -
              1,
          ),
        },
      });
      return { state: "completed" };
    });
  }
}
