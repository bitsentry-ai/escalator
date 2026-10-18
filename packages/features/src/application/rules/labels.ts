import {
  incidentLabelSchema,
  incidentLabelInputSchema,
  type IncidentLabel,
  type IncidentLabelInput,
} from "../../contracts/rule-label.js";
import {
  hasCapability,
  opaqueIdSchema,
  type Actor,
} from "../../contracts/identity.js";
import { utcTimestampSchema } from "../../contracts/entities.js";

export class IncidentLabelError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "conflict"
      | "immutable"
      | "scope_violation",
  ) {
    super(code);
  }
}
function authorize(actor: Actor, current?: IncidentLabel): void {
  if (!hasCapability(actor.role, "incident:resolve"))
    throw new IncidentLabelError("forbidden");
  if (current && current.workspaceId !== actor.workspaceId)
    throw new IncidentLabelError("scope_violation");
}
function editable(
  actor: Actor,
  raw: IncidentLabel,
  expectedRevision: number,
  at: string,
): IncidentLabel {
  const value = incidentLabelSchema.parse(raw);
  authorize(actor, value);
  if (value.status === "reviewed") throw new IncidentLabelError("immutable");
  if (value.revision !== expectedRevision)
    throw new IncidentLabelError("conflict");
  utcTimestampSchema.parse(at);
  if (Date.parse(at) < Date.parse(value.updatedAt))
    throw new IncidentLabelError("conflict");
  return value;
}
/** Pure mutation specifications. Host repositories must validate referenced
 * service/environment/stream/incident ownership, persist with revision CAS,
 * and append the corresponding human audit event in one transaction.
 */
export function createIncidentLabel(
  actor: Actor,
  id: string,
  input: IncidentLabelInput,
  at: string,
): IncidentLabel {
  authorize(actor);
  opaqueIdSchema.parse(id);
  utcTimestampSchema.parse(at);
  return incidentLabelSchema.parse({
    ...incidentLabelInputSchema.parse(input),
    id,
    workspaceId: actor.workspaceId,
    revision: 1,
    status: "draft",
    createdBy: actor.responderId,
    createdAt: at,
    updatedAt: at,
    reviewedBy: null,
    reviewedAt: null,
  });
}
export function editIncidentLabel(
  actor: Actor,
  raw: IncidentLabel,
  expectedRevision: number,
  input: IncidentLabelInput,
  at: string,
): IncidentLabel {
  const current = editable(actor, raw, expectedRevision, at),
    content = incidentLabelInputSchema.parse(input);
  if (
    content.serviceId !== current.serviceId ||
    content.environmentId !== current.environmentId ||
    content.stream.id !== current.stream.id ||
    content.stream.kind !== current.stream.kind ||
    content.origin !== current.origin ||
    content.incidentId !== current.incidentId
  )
    throw new IncidentLabelError("scope_violation");
  return incidentLabelSchema.parse({
    ...current,
    ...content,
    revision: current.revision + 1,
    updatedAt: at,
  });
}
export function reviewIncidentLabel(
  actor: Actor,
  raw: IncidentLabel,
  expectedRevision: number,
  at: string,
): IncidentLabel {
  const current = editable(actor, raw, expectedRevision, at);
  return incidentLabelSchema.parse({
    ...current,
    revision: current.revision + 1,
    status: "reviewed",
    reviewedBy: actor.responderId,
    reviewedAt: at,
    updatedAt: at,
  });
}
