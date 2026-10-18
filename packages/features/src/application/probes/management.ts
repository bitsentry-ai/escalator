import {
  hasCapability,
  probeSchema,
  signalSourceSchema,
  type Actor,
  type Probe,
  type WorkspaceId,
} from "../../contracts/index.js";
import {
  createProbeSchema,
  updateProbeSchema,
  probeIdInputSchema,
  probePageSchema,
  probeHistorySchema,
  disableProbeSchema,
  type CreateProbeInput,
  type UpdateProbeInput,
} from "../../contracts/probe-inputs.js";
import { PersistenceError } from "../ports/persistence.js";
import type { ProbeRepository, ProbeTransaction } from "./ports.js";
import { scheduleProbe } from "./execute.js";
import {
  assertProbeCapacity,
  probeLimitsSchema,
  defaultProbeLimits,
  type ProbeLimits,
} from "./capacity.js";
export class ProbeManagementError extends Error {
  constructor(readonly code: "forbidden" | "conflict" | "destination_denied") {
    super(code);
  }
}
function authorize(actor: Actor, write = false) {
  if (!hasCapability(actor.role, write ? "service:manage" : "service:read"))
    throw new ProbeManagementError("forbidden");
}
/** Deployment policy is injected by the host; callers can never modify its allowed destinations. */
export class ProbeManagement {
  private readonly limits: ProbeLimits;
  constructor(
    private readonly repository: ProbeRepository,
    private readonly newId: () => string,
    private readonly destinations: {
      target(url: string, scope: WorkspaceId): unknown;
    },
    limits: ProbeLimits = { ...defaultProbeLimits },
  ) {
    this.limits = probeLimitsSchema.parse(limits);
  }
  private destination(probe: Probe) {
    if (probe.enabled)
      try {
        if (
          probe.config.authSecretId &&
          new URL(probe.config.url).protocol !== "https:"
        )
          throw new Error("Credentialed probe requires HTTPS");
        this.destinations.target(probe.config.url, probe.workspaceId);
      } catch {
        throw new ProbeManagementError("destination_denied");
      }
  }
  private audit(
    tx: ProbeTransaction,
    actor: Actor,
    probe: Probe,
    action: string,
  ) {
    return tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType: "probe",
      subjectId: probe.id,
      recordedAt: tx.now,
      metadata: { version: probe.version, enabled: probe.enabled },
    });
  }
  async list(actor: Actor, input: { after?: string; limit?: number } = {}) {
    authorize(actor);
    const page = probePageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.probes.list(page),
    );
  }
  async get(actor: Actor, input: { id: string }) {
    authorize(actor);
    const { id } = probeIdInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const probe = await tx.probes.get(id);
      if (!probe) throw new PersistenceError("not_found");
      const state = (await tx.probes.state(id)) ?? null;
      const lastResult = state
        ? ((await tx.probes.result(state.lastResultId)) ?? null)
        : null;
      if (
        lastResult &&
        (lastResult.workspaceId !== actor.workspaceId ||
          lastResult.probeId !== id ||
          lastResult.id !== state?.lastResultId)
      )
        throw new PersistenceError("scope_violation");
      return {
        probe,
        state,
        lastResult,
        schedule: (await tx.probes.schedule(id)) ?? null,
      };
    });
  }
  async history(
    actor: Actor,
    input: { id: string; after?: string; limit?: number },
  ) {
    authorize(actor);
    const { id, ...page } = probeHistorySchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.probes.get(id))) throw new PersistenceError("not_found");
      return tx.probes.results(id, page);
    });
  }
  async create(actor: Actor, input: CreateProbeInput) {
    authorize(actor, true);
    const fields = createProbeSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.probes.lockCapacity();
      const probe = probeSchema.parse({
        ...fields,
        id: this.newId(),
        sourceId: this.newId(),
        workspaceId: actor.workspaceId,
        version: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      this.destination(probe);
      await assertProbeCapacity(tx, probe, this.limits);
      await tx.sources.insert(
        signalSourceSchema.parse({
          id: probe.sourceId,
          workspaceId: actor.workspaceId,
          serviceId: probe.serviceId,
          environmentId: probe.environmentId,
          name: probe.name,
          kind: "probe",
          enabled: probe.enabled,
          version: 1,
          grouping: "source-fingerprint",
          recovery: "explicit",
          recoveryHoldSeconds: 60,
          authSecretId: null,
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
      );
      if (!(await tx.probes.put(probe, null)))
        throw new ProbeManagementError("conflict");
      await scheduleProbe(tx, probe, tx.now);
      await this.audit(tx, actor, probe, "probe.created");
      return probe;
    });
  }
  async update(actor: Actor, input: UpdateProbeInput) {
    authorize(actor, true);
    const { id, expectedVersion, ...fields } = updateProbeSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.probes.lockCapacity();
      const current = await tx.probes.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new ProbeManagementError("conflict");
      const probe = probeSchema.parse({
        ...current,
        ...fields,
        version: current.version + 1,
        updatedAt: tx.now,
      });
      this.destination(probe);
      // Disabling must remain possible after deployment limits or network policy are tightened.
      if (probe.enabled) await assertProbeCapacity(tx, probe, this.limits);
      return this.save(tx, actor, probe, current.version, "probe.updated");
    });
  }
  async disable(actor: Actor, input: { id: string; expectedVersion: number }) {
    authorize(actor, true);
    const { id, expectedVersion } = disableProbeSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await tx.probes.lockCapacity();
      const current = await tx.probes.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new ProbeManagementError("conflict");
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
        "probe.disabled",
      );
    });
  }
  private async save(
    tx: ProbeTransaction,
    actor: Actor,
    probe: Probe,
    expected: number,
    action: string,
  ) {
    const source = await tx.sources.get(probe.sourceId);
    if (!source) throw new PersistenceError("not_found");
    if (!(await tx.probes.put(probe, expected)))
      throw new ProbeManagementError("conflict");
    if (
      !(await tx.sources.replace(
        {
          ...source,
          name: probe.name,
          enabled: probe.enabled,
          version: source.version + 1,
          updatedAt: tx.now,
        },
        source.version,
      ))
    )
      throw new ProbeManagementError("conflict");
    await scheduleProbe(tx, probe, tx.now);
    await this.audit(tx, actor, probe, action);
    return probe;
  }
}
