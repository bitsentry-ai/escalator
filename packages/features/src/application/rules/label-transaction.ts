import { z } from "zod";
import {
  hasCapability,
  opaqueIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  type Actor,
} from "../../contracts/identity.js";
import {
  incidentLabelSchema,
  incidentLabelInputSchema,
  type IncidentLabel,
  type IncidentLabelInput,
} from "../../contracts/rule-label.js";
import {
  PersistenceError,
  type FoundationTransaction,
  type PageRequest,
} from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  IncidentLabelRecordStore,
  IncidentLabelTransaction,
  LabelSelection,
} from "./label-ports.js";
import {
  createIncidentLabel,
  editIncidentLabel,
  reviewIncidentLabel,
  IncidentLabelError,
} from "./labels.js";

const selectionSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  stream: incidentLabelInputSchema.shape.stream.optional(),
  status: z.enum(["draft", "reviewed"]).optional(),
  incidentId: opaqueIdSchema.optional(),
});
const pageSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  after: opaqueIdSchema.optional(),
});

export function withIncidentLabels<Tx extends FoundationTransaction>(
  base: Tx,
  store: IncidentLabelRecordStore,
  guard: TransactionGuard,
  newId: () => string,
): Tx & IncidentLabelTransaction {
  function bound(raw: IncidentLabel): IncidentLabel {
    const row = incidentLabelSchema.parse(raw);
    if (row.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
    return row;
  }
  async function authorize(actor: Actor, write: boolean): Promise<void> {
    if (actor.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
    if (
      !hasCapability(actor.role, write ? "incident:resolve" : "incident:read")
    )
      throw new IncidentLabelError("forbidden");
    const responder = await base.responders.get(actor.responderId);
    if (
      !responder ||
      !responder.enabled ||
      responder.role !== actor.role ||
      responder.id !== actor.responderId ||
      responder.workspaceId !== base.workspaceId
    )
      throw new IncidentLabelError("forbidden");
  }
  async function references(input: IncidentLabelInput): Promise<void> {
    const service = await base.services.get(input.serviceId),
      environment = await base.environments.get(input.environmentId);
    if (!service || !environment) throw new PersistenceError("not_found");
    const stream = await store.lockStream(input.stream);
    if (!stream) throw new PersistenceError("not_found");
    if (
      service.workspaceId !== base.workspaceId ||
      environment.workspaceId !== base.workspaceId ||
      service.id !== input.serviceId ||
      environment.id !== input.environmentId ||
      stream.workspaceId !== base.workspaceId ||
      stream.serviceId !== input.serviceId ||
      stream.environmentId !== input.environmentId ||
      stream.kind !== input.stream.kind ||
      stream.id !== input.stream.id
    )
      throw new PersistenceError("scope_violation");
    if (input.incidentId !== null) {
      const incident = await store.incident(input.incidentId);
      if (!incident) throw new PersistenceError("not_found");
      if (
        incident.workspaceId !== base.workspaceId ||
        incident.serviceId !== input.serviceId ||
        incident.environmentId !== input.environmentId ||
        incident.id !== input.incidentId
      )
        throw new PersistenceError("scope_violation");
    }
  }
  async function locked(id: string): Promise<IncidentLabel> {
    opaqueIdSchema.parse(id);
    const locator = await store.get(id, false);
    if (!locator) throw new PersistenceError("not_found");
    const current = bound(locator);
    if (current.id !== id) throw new PersistenceError("scope_violation");
    await references(current);
    const raw = await store.get(id, true);
    if (!raw) throw new PersistenceError("not_found");
    const row = bound(raw);
    if (
      row.id !== id ||
      row.serviceId !== current.serviceId ||
      row.environmentId !== current.environmentId ||
      row.stream.kind !== current.stream.kind ||
      row.stream.id !== current.stream.id ||
      row.incidentId !== current.incidentId
    )
      throw new PersistenceError("scope_violation");
    return row;
  }
  async function save(
    actor: Actor,
    value: IncidentLabel,
    expected: number | null,
    action: string,
  ): Promise<IncidentLabel> {
    guard.assertCommittable();
    if (!(await store.put(value, expected)))
      throw new IncidentLabelError("conflict");
    await base.audit.append({
      id: newId(),
      workspaceId: base.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType: "incident-label",
      subjectId: value.id,
      recordedAt: value.updatedAt,
      metadata: {
        revision: value.revision,
        status: value.status,
        serviceId: value.serviceId,
        environmentId: value.environmentId,
        streamKind: value.stream.kind,
        streamId: value.stream.id,
        origin: value.origin,
        outcome: value.outcome,
        incidentId: value.incidentId,
      },
    });
    return value;
  }
  async function list(
    actor: Actor,
    selection: LabelSelection,
    page: PageRequest,
  ) {
    await authorize(actor, false);
    const filter = selectionSchema.parse(selection),
      query = pageSchema.parse(page),
      result = await store.list(filter, query);
    const rows = result.items.map(bound);
    if (
      rows.length > query.limit ||
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      (result.next !== null &&
        (rows.length !== query.limit || result.next !== rows.at(-1)?.id))
    )
      throw new PersistenceError("invalid_page");
    let previous = query.after;
    for (const row of rows) {
      if (previous !== undefined && row.id <= previous)
        throw new PersistenceError("invalid_page");
      previous = row.id;
      if (
        row.serviceId !== filter.serviceId ||
        row.environmentId !== filter.environmentId ||
        (filter.status && row.status !== filter.status) ||
        (filter.incidentId && row.incidentId !== filter.incidentId) ||
        (filter.stream &&
          (row.stream.kind !== filter.stream.kind ||
            row.stream.id !== filter.stream.id))
      )
        throw new PersistenceError("scope_violation");
    }
    return { items: rows, next: result.next };
  }
  return {
    ...base,
    labels: {
      get: (actor, id) =>
        guard.operation(async () => {
          await authorize(actor, false);
          opaqueIdSchema.parse(id);
          const raw = await store.get(id, false);
          if (!raw) return undefined;
          const value = bound(raw);
          if (value.id !== id) throw new PersistenceError("scope_violation");
          return value;
        }),
      list: (actor, selection, page) =>
        guard.operation(() => list(actor, selection, page)),
      create: (actor, raw) =>
        guard.operation(async () => {
          await authorize(actor, true);
          const input = incidentLabelInputSchema.parse(raw);
          await references(input);
          const value = createIncidentLabel(
            actor,
            newId(),
            input,
            await store.currentTime(),
          );
          return save(actor, value, null, "rule.label_created");
        }),
      edit: (actor, id, expected, input) =>
        guard.operation(async () => {
          await authorize(actor, true);
          const current = await locked(id);
          const value = editIncidentLabel(
            actor,
            current,
            expected,
            input,
            await store.currentTime(),
          );
          return save(actor, value, expected, "rule.label_edited");
        }),
      review: (actor, id, expected) =>
        guard.operation(async () => {
          await authorize(actor, true);
          const current = await locked(id);
          const value = reviewIncidentLabel(
            actor,
            current,
            expected,
            await store.currentTime(),
          );
          return save(actor, value, expected, "rule.label_reviewed");
        }),
    },
  };
}
