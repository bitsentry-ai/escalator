import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  type MetricMonitor,
  type SignalSource,
} from "../../contracts/index.js";
import type { MetricObservationInput } from "../../contracts/metric-records.js";
import type { MetricsObservation } from "../../contracts/metrics.js";
import { MetricsReadError } from "../../adapters/metrics/normalize.js";
import type { PrometheusMetricsReader } from "../../adapters/metrics/reader.js";
import type { WorkLease } from "../jobs/ports.js";
import type { WorkHandlerResult } from "../jobs/runner.js";
import { recordSignal } from "../signals/record.js";
import type { MetricsRepository, MetricsTransaction } from "./ports.js";
import { metricJobId, metricPointAt, nextMetricDueAt } from "./schedule.js";
export const metricJobPayloadSchema = z.strictObject({
  monitorId: opaqueIdSchema,
  monitorVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  dueAt: utcTimestampSchema,
  secretIds: z.array(opaqueIdSchema).max(1),
});
export async function scheduleMetric(
  tx: MetricsTransaction,
  monitor: MetricMonitor,
  dueAt: string,
  lastObservationId: string | null = null,
  cancelPrevious = true,
) {
  const old = await tx.metrics.schedule(monitor.id);
  const jobId = monitor.enabled
    ? metricJobId(tx.workspaceId, monitor.id, monitor.version, dueAt)
    : null;
  if (cancelPrevious && old?.jobId && old.jobId !== jobId)
    await tx.work.cancel("job", [old.jobId]);
  if (jobId)
    await tx.work.enqueue("job", {
      id: jobId,
      kind: "metrics.poll",
      idempotencyKey: jobId,
      dueAt,
      payload: {
        monitorId: monitor.id,
        monitorVersion: monitor.version,
        dueAt,
        secretIds: monitor.query.connection.authSecretId
          ? [monitor.query.connection.authSecretId]
          : [],
      },
    });
  await tx.metrics.putSchedule({
    workspaceId: tx.workspaceId,
    monitorId: monitor.id,
    monitorVersion: monitor.version,
    jobId,
    dueAt: jobId ? dueAt : null,
    lastObservationId,
  });
}
type Ready = {
  monitor: MetricMonitor;
  source: SignalSource;
  dueAt: string;
  point: string;
  unavailable: "service_disabled" | "source_disabled" | null;
};
/** Network I/O occurs between two fenced transactions. The immutable receipt precedes settlement. */
export class MetricPollingJobs {
  constructor(
    private readonly repository: MetricsRepository,
    private readonly reader: Pick<PrometheusMetricsReader, "read">,
  ) {}
  private async prepare(
    tx: MetricsTransaction,
    lease: WorkLease,
  ): Promise<Ready | { result: WorkHandlerResult }> {
    const hint = metricJobPayloadSchema.parse(lease.payload);
    const monitor = await tx.metrics.lock(hint.monitorId);
    const claim = await tx.work.lockClaim(lease);
    if (!claim) return { result: { state: "stale" } };
    const payload = metricJobPayloadSchema.parse(claim.payload);
    if (
      claim.queue !== "job" ||
      claim.kind !== "metrics.poll" ||
      payload.monitorId !== hint.monitorId ||
      claim.id !==
        metricJobId(
          tx.workspaceId,
          payload.monitorId,
          payload.monitorVersion,
          payload.dueAt,
        )
    )
      throw new Error("Invalid metric claim");
    if (await tx.metrics.observation(claim.id))
      return { result: { state: "completed" } };
    if (!monitor) throw new Error("Missing metric configuration");
    if (!monitor.enabled || monitor.version !== payload.monitorVersion)
      return { result: { state: "completed" } };
    const scheduled = await tx.metrics.schedule(monitor.id);
    if (!scheduled) throw new Error("Missing metric schedule");
    if (
      scheduled.jobId !== claim.id ||
      scheduled.monitorVersion !== monitor.version ||
      scheduled.dueAt !== payload.dueAt
    )
      return { result: { state: "completed" } };
    const expected = monitor.query.connection.authSecretId
      ? [monitor.query.connection.authSecretId]
      : [];
    if (JSON.stringify(expected) !== JSON.stringify(payload.secretIds))
      throw new Error("Invalid metric credential binding");
    const now = await tx.currentTime();
    const remaining = Date.parse(payload.dueAt) - Date.parse(now);
    if (remaining > 0)
      return {
        result: { state: "wait", delayMs: Math.min(3600000, remaining) },
      };
    const source = await tx.sources.get(monitor.sourceId);
    const service = await tx.services.get(monitor.serviceId);
    if (
      !source ||
      source.kind !== "metrics" ||
      source.serviceId !== monitor.serviceId ||
      source.environmentId !== monitor.environmentId
    )
      throw new Error("Invalid metric source");
    return {
      monitor,
      source,
      dueAt: payload.dueAt,
      point: metricPointAt(now, monitor.stepSeconds),
      unavailable: !source.enabled
        ? "source_disabled"
        : !service?.enabled
          ? "service_disabled"
          : null,
    };
  }
  async poll(
    lease: WorkLease,
    signal: AbortSignal,
  ): Promise<WorkHandlerResult> {
    if (signal.aborted) return { state: "stale" };
    const ready = await this.repository.transaction(lease.workspaceId, (tx) =>
      this.prepare(tx, lease),
    );
    if ("result" in ready) return ready.result;
    let observation: MetricsObservation | null = null;
    let reason: MetricObservationInput["reason"] =
      ready.unavailable ?? "sampled";
    if (!ready.unavailable)
      try {
        observation = await this.reader.read(
          ready.monitor.query,
          {
            startAt: ready.point,
            endAt: ready.point,
            stepSeconds: ready.monitor.stepSeconds,
          },
          {
            workspaceId: lease.workspaceId,
            workId: lease.id,
            claimToken: lease.token,
            signal,
          },
        );
      } catch (error) {
        reason =
          error instanceof MetricsReadError
            ? error.code
            : "provider_unavailable";
      }
    if (signal.aborted) return { state: "stale" };
    return this.repository.transaction(lease.workspaceId, async (tx) => {
      const current = await this.prepare(tx, lease);
      if ("result" in current) return current.result;
      const monitor = current.monitor;
      if (current.unavailable) reason = current.unavailable;
      if (
        Date.parse(tx.now) - Date.parse(ready.point) >
        2 * monitor.stepSeconds * 1000
      )
        reason = "stale_window";
      if (
        reason === "sampled" &&
        (!observation || observation.samples.length !== 1)
      )
        throw new Error("Invalid metric observation");
      const record = await tx.metrics.observe({
        id: lease.id,
        workspaceId: tx.workspaceId,
        monitorId: monitor.id,
        monitorVersion: monitor.version,
        observedAt: ready.point,
        receivedAt: tx.now,
        reason,
        sample: reason === "sampled" ? observation!.samples[0] : null,
        provenance: reason === "sampled" ? observation!.provenance : null,
      });
      if (record.evaluation.state !== "insufficient_data")
        await recordSignal(tx, current.source, "internal-metrics", {
          version: 1,
          eventId: `metrics:${record.id}`,
          fingerprint: `metrics:${monitor.id}`,
          observedAt: record.observedAt,
          status: record.evaluation.state === "active" ? "active" : "recovered",
          severity: "high",
          title: `Metrics: ${monitor.name}`,
          evidence: {
            summary:
              record.evaluation.state === "active"
                ? "Sustained error floor exceeded"
                : "Sustained error floor cleared",
            attributes: [
              { name: "monitorId", value: monitor.id },
              { name: "observationId", value: record.id },
              {
                name: "evaluatorVersion",
                value: String(record.evaluation.evaluatorVersion),
              },
            ],
          },
        });
      const next = nextMetricDueAt(
        current.dueAt,
        await tx.currentTime(),
        monitor.stepSeconds,
      );
      await scheduleMetric(tx, monitor, next.dueAt, record.id, false);
      await tx.audit.append({
        id: `metric.observed:${record.id}`,
        workspaceId: tx.workspaceId,
        actor: { kind: "system", component: "metrics-scheduler" },
        action: "metric.observed",
        subjectType: "metric",
        subjectId: monitor.id,
        recordedAt: tx.now,
        metadata: {
          observationId: record.id,
          monitorVersion: monitor.version,
          verdict: record.evaluation.state,
          reason,
          skippedSlots: next.skippedSlots,
        },
      });
      return { state: "completed" };
    });
  }
}
