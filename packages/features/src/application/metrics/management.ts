import {
  hasCapability,
  metricMonitorSchema,
  signalSourceSchema,
  type Actor,
  type MetricMonitor,
  type WorkspaceId,
} from "../../contracts/index.js";
import {
  createMetricSchema,
  updateMetricSchema,
  metricIdInputSchema,
  metricPageSchema,
  metricHistorySchema,
  disableMetricSchema,
  type CreateMetricInput,
  type UpdateMetricInput,
} from "../../contracts/metric-inputs.js";
import { PersistenceError } from "../ports/persistence.js";
import type { MetricsRepository, MetricsTransaction } from "./ports.js";
import { scheduleMetric } from "./jobs.js";
import {
  assertMetricCapacity,
  metricLimitsSchema,
  defaultMetricLimits,
  type MetricLimits,
} from "./capacity.js";
export class MetricManagementError extends Error {
  constructor(readonly code: "forbidden" | "conflict" | "destination_denied") {
    super(code);
  }
}
function authorize(actor: Actor, write = false) {
  if (!hasCapability(actor.role, write ? "service:manage" : "service:read"))
    throw new MetricManagementError("forbidden");
}
/** Deployment policy is injected by the host; callers can never modify its allowed destinations. */
export class MetricManagement {
  private readonly limits: MetricLimits;
  constructor(
    private readonly repository: MetricsRepository,
    private readonly newId: () => string,
    private readonly destinations: {
      target(url: string, scope: WorkspaceId): unknown;
    },
    limits: MetricLimits = { ...defaultMetricLimits },
  ) {
    this.limits = metricLimitsSchema.parse(limits);
  }
  private destination(metric: MetricMonitor) {
    if (metric.enabled)
      try {
        if (
          metric.query.connection.authSecretId &&
          new URL(metric.query.connection.baseUrl).protocol !== "https:"
        )
          throw new Error("Credentialed metric requires HTTPS");
        this.destinations.target(
          metric.query.connection.baseUrl,
          metric.workspaceId,
        );
      } catch {
        throw new MetricManagementError("destination_denied");
      }
  }
  private audit(
    tx: MetricsTransaction,
    actor: Actor,
    metric: MetricMonitor,
    action: string,
  ) {
    return tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType: "metric",
      subjectId: metric.id,
      recordedAt: tx.now,
      metadata: { version: metric.version, enabled: metric.enabled },
    });
  }
  async list(actor: Actor, input: { after?: string; limit?: number } = {}) {
    authorize(actor);
    const page = metricPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.metrics.list(page),
    );
  }
  async get(actor: Actor, input: { id: string }) {
    authorize(actor);
    const { id } = metricIdInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const metric = await tx.metrics.get(id);
      if (!metric) throw new PersistenceError("not_found");
      return {
        metric,
        schedule: (await tx.metrics.schedule(id)) ?? null,
      };
    });
  }
  async history(
    actor: Actor,
    input: { id: string; after?: string; limit?: number },
  ) {
    authorize(actor);
    const { id, ...page } = metricHistorySchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.metrics.get(id))) throw new PersistenceError("not_found");
      return tx.metrics.history(id, page);
    });
  }
  async create(actor: Actor, input: CreateMetricInput) {
    authorize(actor, true);
    const fields = createMetricSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.metrics.lockCapacity();
      const metric = metricMonitorSchema.parse({
        ...fields,
        id: this.newId(),
        sourceId: this.newId(),
        workspaceId: actor.workspaceId,
        version: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      this.destination(metric);
      await assertMetricCapacity(tx, metric, this.limits);
      await tx.sources.insert(
        signalSourceSchema.parse({
          id: metric.sourceId,
          workspaceId: actor.workspaceId,
          serviceId: metric.serviceId,
          environmentId: metric.environmentId,
          name: metric.name,
          kind: "metrics",
          enabled: metric.enabled,
          version: 1,
          grouping: "source-fingerprint",
          recovery: "explicit",
          recoveryHoldSeconds: 60,
          authSecretId: null,
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
      );
      if (!(await tx.metrics.put(metric, null)))
        throw new MetricManagementError("conflict");
      await scheduleMetric(tx, metric, tx.now);
      await this.audit(tx, actor, metric, "metric.created");
      return metric;
    });
  }
  async update(actor: Actor, input: UpdateMetricInput) {
    authorize(actor, true);
    const { id, expectedVersion, ...fields } = updateMetricSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.metrics.lockCapacity();
      const current = await tx.metrics.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new MetricManagementError("conflict");
      const metric = metricMonitorSchema.parse({
        ...current,
        ...fields,
        version: current.version + 1,
        updatedAt: tx.now,
      });
      this.destination(metric);
      // Disabling must remain possible after deployment limits or network policy are tightened.
      if (metric.enabled) await assertMetricCapacity(tx, metric, this.limits);
      return this.save(tx, actor, metric, current.version, "metric.updated");
    });
  }
  async disable(actor: Actor, input: { id: string; expectedVersion: number }) {
    authorize(actor, true);
    const { id, expectedVersion } = disableMetricSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.metrics.lockCapacity();
      const current = await tx.metrics.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new MetricManagementError("conflict");
      return this.save(
        tx,
        actor,
        {
          ...current,
          enabled: false,
          version: current.version + 1,
          updatedAt: tx.now,
        },
        current.version,
        "metric.disabled",
      );
    });
  }
  private async save(
    tx: MetricsTransaction,
    actor: Actor,
    metric: MetricMonitor,
    expected: number,
    action: string,
  ) {
    const source = await tx.sources.get(metric.sourceId);
    if (!source) throw new PersistenceError("not_found");
    if (!(await tx.metrics.put(metric, expected)))
      throw new MetricManagementError("conflict");
    if (
      !(await tx.sources.replace(
        {
          ...source,
          name: metric.name,
          enabled: metric.enabled,
          version: source.version + 1,
          updatedAt: tx.now,
        },
        source.version,
      ))
    )
      throw new MetricManagementError("conflict");
    await scheduleMetric(tx, metric, tx.now);
    await this.audit(tx, actor, metric, action);
    return metric;
  }
}
