import { createHash } from "node:crypto";
import {
  metricMonitorSchema,
  metricScheduleSchema,
  metricObservationInputSchema,
  metricObservationSchema,
  type MetricMonitor,
  type MetricObservationInput,
} from "../../contracts/metric-records.js";
import { opaqueIdSchema } from "../../contracts/identity.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { PersistenceError, type PageRequest } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { SignalTransaction } from "../signals/ports.js";
import type {
  MetricsRecordStore,
  MetricsTransaction,
  MetricWindow,
} from "./ports.js";
import { metricJobId, metricPointAt, metricWindowAt } from "./schedule.js";
import { evaluateSustainedFloor } from "../../domain/rules/sustained-floor.js";
export class MetricPersistenceError extends Error {
  constructor(
    readonly code:
      | "invalid_metric"
      | "invalid_observation"
      | "invalid_schedule"
      | "identity_change"
      | "invalid_lock_order",
  ) {
    super(code);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PersistenceError("not_found");
  return value;
}
function page(input: PageRequest) {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined &&
      !opaqueIdSchema.safeParse(input.after).success)
  )
    throw new PersistenceError("invalid_page");
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function metricsTransaction(
  base: SignalTransaction,
  store: MetricsRecordStore,
  guard: TransactionGuard,
): MetricsTransaction {
  const locked = new Map<string, MetricMonitor>();
  let capacityLocked = false;
  const scoped = (value: { workspaceId: string }) => {
    if (value.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  const owning = (id: string) => required(locked.get(id));
  const validateWindow = (query: MetricWindow) => {
    opaqueIdSchema.parse(query.monitorId);
    utcTimestampSchema.parse(query.startAt);
    utcTimestampSchema.parse(query.endAt);
    utcTimestampSchema.parse(query.visibleAt);
    if (
      !Number.isSafeInteger(query.monitorVersion) ||
      query.monitorVersion < 1 ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1440 ||
      Date.parse(query.endAt) < Date.parse(query.startAt) ||
      Date.parse(query.endAt) - Date.parse(query.startAt) > 86400000
    )
      throw new MetricPersistenceError("invalid_observation");
  };
  async function window(query: MetricWindow) {
    validateWindow(query);
    const records = await store.window(query);
    if (records.length > query.limit)
      throw new MetricPersistenceError("invalid_observation");
    let previous = -Infinity;
    for (const record of records) {
      scoped(record);
      const at = Date.parse(record.observedAt);
      if (
        record.monitorId !== query.monitorId ||
        record.monitorVersion !== query.monitorVersion ||
        at < Date.parse(query.startAt) ||
        at > Date.parse(query.endAt) ||
        at <= previous ||
        Date.parse(record.receivedAt) > Date.parse(query.visibleAt)
      )
        throw new MetricPersistenceError("invalid_observation");
      previous = at;
    }
    return records;
  }
  return {
    ...base,
    metrics: {
      lockCapacity: () =>
        guard.operation(async () => {
          if (capacityLocked) return;
          if (locked.size)
            throw new MetricPersistenceError("invalid_lock_order");
          await store.lockCapacity();
          capacityLocked = true;
        }),
      get: (id) => guard.operation(() => store.get(opaqueIdSchema.parse(id))),
      lock: (id) =>
        guard.operation(async () => {
          const hint = await store.get(opaqueIdSchema.parse(id));
          if (!hint) return undefined;
          required(await base.sources.get(hint.sourceId));
          const value = await store.get(id, true);
          if (value) locked.set(id, value);
          return value;
        }),
      list: (input) =>
        guard.operation(() => {
          page(input);
          return store.list(input);
        }),
      put: (input, expected) =>
        guard.operation(async () => {
          const value = metricMonitorSchema.parse(input);
          scoped(value);
          if (
            value.version !== (expected ?? 0) + 1 ||
            (expected !== null &&
              (!Number.isSafeInteger(expected) || expected < 1)) ||
            value.updatedAt !== base.now ||
            (expected === null && value.createdAt !== base.now)
          )
            throw new MetricPersistenceError("invalid_metric");
          const source = required(await base.sources.get(value.sourceId));
          if (
            source.kind !== "metrics" ||
            source.serviceId !== value.serviceId ||
            source.environmentId !== value.environmentId
          )
            throw new MetricPersistenceError("invalid_metric");
          const current = await store.get(value.id, true);
          if ((current?.version ?? null) !== expected) return false;
          if (current)
            for (const key of [
              "sourceId",
              "serviceId",
              "environmentId",
              "createdAt",
            ] as const)
              if (value[key] !== current[key])
                throw new MetricPersistenceError("identity_change");
          const secret = value.query.connection.authSecretId;
          if (
            secret &&
            (value.enabled ||
              current?.query.connection.authSecretId !== secret) &&
            !(await store.hasSecret(secret))
          )
            throw new PersistenceError("not_found");
          const saved = await store.put(value, expected);
          if (saved) locked.set(value.id, value);
          return saved;
        }),
      version: (id, version) =>
        guard.operation(() => {
          opaqueIdSchema.parse(id);
          if (!Number.isSafeInteger(version) || version < 1)
            throw new MetricPersistenceError("invalid_metric");
          return store.version(id, version);
        }),
      schedule: (id) =>
        guard.operation(() => store.schedule(opaqueIdSchema.parse(id))),
      putSchedule: (input) =>
        guard.operation(async () => {
          const value = metricScheduleSchema.parse(input);
          scoped(value);
          const monitor = owning(value.monitorId);
          if (
            value.monitorVersion !== monitor.version ||
            (value.jobId !== null &&
              (!monitor.enabled ||
                value.jobId !==
                  metricJobId(
                    base.workspaceId,
                    monitor.id,
                    monitor.version,
                    value.dueAt!,
                  )))
          )
            throw new MetricPersistenceError("invalid_schedule");
          if (value.lastObservationId) {
            const record = required(
              await store.observation(value.lastObservationId),
            );
            if (
              record.monitorId !== monitor.id ||
              record.monitorVersion !== monitor.version
            )
              throw new MetricPersistenceError("invalid_schedule");
          }
          await store.putSchedule(value);
        }),
      observation: (id) =>
        guard.operation(() => store.observation(opaqueIdSchema.parse(id))),
      history: (id, input) =>
        guard.operation(() => {
          opaqueIdSchema.parse(id);
          page(input);
          return store.history(id, input);
        }),
      window: (query) => guard.operation(() => window(query)),
      observe: (input) =>
        guard.operation(async () => {
          const value = metricObservationInputSchema.parse(input);
          scoped(value);
          const monitor = owning(value.monitorId);
          if (
            value.monitorVersion !== monitor.version ||
            value.receivedAt !== base.now ||
            Date.parse(value.observedAt) > Date.parse(base.now) ||
            metricPointAt(value.observedAt, monitor.stepSeconds) !==
              value.observedAt
          )
            throw new MetricPersistenceError("invalid_observation");
          const previous = await store.observation(value.id);
          if (previous) {
            if (
              previous.monitorId !== monitor.id ||
              previous.monitorVersion !== monitor.version
            )
              throw new PersistenceError("already_exists");
            return previous;
          }
          if (value.sample) {
            const p = value.provenance!;
            if (
              Date.parse(base.now) - Date.parse(value.observedAt) >
                2 * monitor.stepSeconds * 1000 ||
              value.sample.observedAt !== value.observedAt ||
              p.provider !== monitor.query.connection.provider ||
              p.datasourceUid !==
                (monitor.query.connection.provider === "grafana-prometheus"
                  ? monitor.query.connection.datasourceUid
                  : null) ||
              p.requestsQueryHash !== hash(monitor.query.requestsQuery) ||
              p.errorsQueryHash !== hash(monitor.query.errorsQuery) ||
              p.range.startAt !== value.observedAt ||
              p.range.endAt !== value.observedAt ||
              p.range.stepSeconds !== monitor.stepSeconds
            )
              throw new MetricPersistenceError("invalid_observation");
          }
          const range = metricWindowAt(monitor, value.observedAt);
          const rows = await window({
            monitorId: monitor.id,
            monitorVersion: monitor.version,
            startAt: range.startAt,
            endAt: range.endAt,
            visibleAt: base.now,
            limit: monitor.rule.windowSeconds / monitor.stepSeconds,
          });
          // Select the same latest-visible receipt on ties that the SQL and replay adapters select.
          const selected = new Map<string, MetricObservationInput>(
            rows.map((row) => [row.observedAt, row]),
          );
          const old = selected.get(value.observedAt);
          if (
            !old ||
            old.receivedAt < value.receivedAt ||
            (old.receivedAt === value.receivedAt && old.id < value.id)
          )
            selected.set(value.observedAt, value);
          const inputs = [...selected.values()].sort((a, b) =>
            a.observedAt < b.observedAt ? -1 : 1,
          );
          const provenance = {
            provider: monitor.query.connection.provider,
            datasourceUid:
              monitor.query.connection.provider === "grafana-prometheus"
                ? monitor.query.connection.datasourceUid
                : null,
            requestsQueryHash: hash(monitor.query.requestsQuery),
            errorsQueryHash: hash(monitor.query.errorsQuery),
            requestsSeriesHash: null,
            errorsSeriesHash: null,
            range,
          };
          const evaluation =
            value.sample?.quality === "complete" &&
            value.sample.requests !== null &&
            value.sample.requests > 0
              ? evaluateSustainedFloor(monitor.rule, {
                  provenance,
                  samples: inputs.map(
                    (row) =>
                      row.sample ?? {
                        observedAt: row.observedAt,
                        requests: null,
                        errors: null,
                        quality: "missing",
                      },
                  ),
                })
              : {
                  evaluatorVersion: 1,
                  state: "insufficient_data",
                  reason: "unusable_samples",
                  sampleCount: inputs.length,
                  requests: null,
                  errors: null,
                  minimumErrorRate: null,
                };
          const record = metricObservationSchema.parse({
            ...value,
            evaluation,
            inputIds: inputs.map((row) => row.id),
          });
          await store.recordObservation(record);
          return record;
        }),
    },
  };
}
