import {
  hasCapability,
  manualIncidentInputSchema,
  createEnvironmentInputSchema,
  environmentSchema,
  incidentPageInputSchema,
  incidentListInputSchema,
  incidentDetailInputSchema,
  incidentDeliveriesInputSchema,
  deliveryAttemptsInputSchema,
  policyDefinition,
  type Actor,
  type Capability,
  type ManualIncidentInput,
  type CreateEnvironmentInput,
  type IncidentPageInput,
  type IncidentListInput,
  type IncidentDeliveriesInput,
  type DeliveryAttemptsInput,
  type IncidentDetail,
  type IncidentDelivery,
  type IncidentAttempt,
  type DeliveryAttempt,
} from "../../contracts/index.js";
import { escalationSteps } from "../../domain/escalation/ladder.js";
import type {
  ConfigurationRepository,
  ConfigurationTransaction,
} from "../configuration/ports.js";
import { PersistenceError } from "../ports/persistence.js";
import {
  findExistingPage,
  openPageInTransaction,
} from "../paging/create-page.js";
import { pagingWorkId } from "../paging/work-ids.js";
export class IncidentError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "not_found"
      | "paging_unavailable"
      | "already_exists",
  ) {
    super(code);
  }
}
function authorize(actor: Actor, capability: Capability) {
  if (!hasCapability(actor.role, capability))
    throw new IncidentError("forbidden");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new IncidentError("not_found");
  return value;
}
function attemptView(value: DeliveryAttempt): IncidentAttempt {
  const {
    id,
    attempt,
    startedAt,
    finishedAt,
    outcome,
    completedAfterAcknowledgement,
    retryable,
    failureReason,
  } = value;
  return {
    id,
    attempt,
    startedAt,
    finishedAt,
    outcome,
    completedAfterAcknowledgement,
    retryable,
    failureReason,
  };
}
async function incidentPage(tx: ConfigurationTransaction, id: string) {
  const incident = required(await tx.incidents.get(id));
  const page = required(
    await tx.pages.get(pagingWorkId(tx.workspaceId, "page", id)),
  );
  if (page.incidentId !== incident.id) throw new IncidentError("not_found");
  return { incident, page };
}
/** Authenticated application surface shared by both hosts; never returns provider credentials. */
export class IncidentUseCases {
  constructor(
    private readonly repository: ConfigurationRepository,
    private readonly newId: () => string,
  ) {}
  async list(actor: Actor, input: IncidentListInput = {}) {
    authorize(actor, "incident:read");
    const query = incidentListInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.incidents.list(query),
    );
  }
  async listEnvironments(actor: Actor, input: IncidentPageInput = {}) {
    authorize(actor, "service:read");
    const query = incidentPageInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.environments.list(query),
    );
  }
  async createEnvironment(actor: Actor, input: CreateEnvironmentInput) {
    authorize(actor, "service:manage");
    const fields = createEnvironmentInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      required(await tx.workspace.get());
      const environment = environmentSchema.parse({
        ...fields,
        id: this.newId(),
        workspaceId: actor.workspaceId,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await tx.environments.insert(environment);
      await tx.audit.append({
        id: this.newId(),
        workspaceId: actor.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "environment.created",
        subjectType: "environment",
        subjectId: environment.id,
        recordedAt: tx.now,
        metadata: {},
      });
      return environment;
    });
  }
  async create(actor: Actor, input: ManualIncidentInput) {
    authorize(actor, "incident:create");
    const fields = manualIncidentInputSchema.parse(input);
    const incident = {
      id: fields.requestId,
      serviceId: fields.serviceId,
      environmentId: fields.environmentId,
      title: fields.title,
      severity: fields.severity,
    };
    const run = () =>
      this.repository.transaction(actor.workspaceId, async (tx) => {
        if (!(await tx.responders.get(actor.responderId))?.enabled)
          throw new IncidentError("forbidden");
        const existing = await findExistingPage(tx, incident);
        if (existing) {
          if (existing.policy.id !== fields.policyId)
            throw new IncidentError("already_exists");
          return { incidentId: incident.id, pageId: existing.id };
        }
        required(await tx.environments.get(fields.environmentId));
        const service = required(await tx.services.get(fields.serviceId));
        if (!service.enabled) throw new IncidentError("paging_unavailable");
        const policy = required(
          await tx.configuration.policies.get(fields.policyId),
        );
        if (!policy.enabled) throw new IncidentError("paging_unavailable");
        if (policy.serviceId !== fields.serviceId)
          throw new IncidentError("not_found");
        const page = await openPageInTransaction(
          tx,
          { incident, policy: policyDefinition(policy) },
          { kind: "responder", responderId: actor.responderId },
        );
        return { incidentId: incident.id, pageId: page.id };
      });
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof PersistenceError) ||
        error.code !== "already_exists"
      )
        throw error;
      // Retry outside the poisoned transaction to read the concurrent winner.
      return run();
    }
  }
  async detail(actor: Actor, input: { id: string }): Promise<IncidentDetail> {
    authorize(actor, "incident:read");
    const { id } = incidentDetailInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const { incident, page } = await incidentPage(tx, id);
      const first = await tx.steps.forPage(page.id, { limit: 100 });
      const second = first.next
        ? await tx.steps.forPage(page.id, { limit: 100, after: first.next })
        : { items: [], next: null };
      if (second.next) throw new Error("Page timeline exceeds policy bounds");
      const recorded = new Map(
        [...first.items, ...second.items].map((step) => [
          step.logicalStepId,
          step,
        ]),
      );
      const owner = page.acknowledgedBy
        ? required(await tx.responders.get(page.acknowledgedBy))
        : null;
      return {
        incident,
        pageId: page.id,
        state: page.state,
        revision: page.revision,
        policyId: page.policy.id,
        policyVersion: page.policy.version,
        owner: owner ? { id: owner.id, displayName: owner.displayName } : null,
        acknowledgedAt: page.acknowledgedAt,
        resolvedAt: page.resolvedAt,
        timeline: escalationSteps(page.policy, page.createdAt).map((step) => {
          const saved = recorded.get(step.id);
          return {
            ...step,
            recordId: saved?.id ?? null,
            recordedAt: saved?.recordedAt ?? null,
            disposition: saved?.disposition ?? "pending",
            recipientCount: saved?.recipientIds.length ?? 0,
          };
        }),
      };
    });
  }
  async deliveries(
    actor: Actor,
    input: IncidentDeliveriesInput,
  ): Promise<{ items: IncidentDelivery[]; next: string | null }> {
    authorize(actor, "incident:read");
    const { incidentId, ...query } = incidentDeliveriesInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const { page } = await incidentPage(tx, incidentId);
      const deliveries = await tx.deliveries.forPage(page.id, query);
      const items: IncidentDelivery[] = [];
      for (const value of deliveries.items) {
        const responder = required(await tx.responders.get(value.recipientId));
        const attempts = await tx.attempts.forDelivery(value.id, { limit: 5 });
        items.push({
          id: value.id,
          stepId: value.stepId,
          recipient: { id: responder.id, displayName: responder.displayName },
          channel: value.channel,
          createdAt: value.createdAt,
          attempts: {
            items: attempts.items.map(attemptView),
            next: attempts.next,
          },
        });
      }
      return { items, next: deliveries.next };
    });
  }
  async attempts(actor: Actor, input: DeliveryAttemptsInput) {
    authorize(actor, "incident:read");
    const { incidentId, deliveryId, ...query } =
      deliveryAttemptsInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const { page } = await incidentPage(tx, incidentId);
      const delivery = required(await tx.deliveries.get(deliveryId));
      if (delivery.pageId !== page.id) throw new IncidentError("not_found");
      const result = await tx.attempts.forDelivery(delivery.id, query);
      return { items: result.items.map(attemptView), next: result.next };
    });
  }
}
