import {
  incidentLabelsQuerySchema,
  incidentLabelIdSchema,
  reviewIncidentLabelSchema,
  editIncidentLabelSchema,
  incidentLabelInputSchema,
  type Actor,
  type IncidentLabelInput,
  type IncidentLabelsQuery,
  type ReviewIncidentLabelInput,
  type EditIncidentLabelInput,
} from "../../contracts/index.js";
import type { IncidentLabelRepository } from "./label-ports.js";
/** Host authentication supplies the actor. The shared transaction authorizes every operation. */
export class IncidentLabelManagement {
  constructor(private readonly repository: IncidentLabelRepository) {}
  get(actor: Actor, input: { id: string }) {
    const query = incidentLabelIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.labels.get(actor, query.id),
    );
  }
  list(actor: Actor, input: IncidentLabelsQuery) {
    const { limit, after, ...selection } =
      incidentLabelsQuerySchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.labels.list(actor, selection, { limit, after }),
    );
  }
  create(actor: Actor, input: IncidentLabelInput) {
    const value = incidentLabelInputSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.labels.create(actor, value),
    );
  }
  edit(actor: Actor, input: EditIncidentLabelInput) {
    const value = editIncidentLabelSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.labels.edit(actor, value.id, value.expectedRevision, value.input),
    );
  }
  review(actor: Actor, input: ReviewIncidentLabelInput) {
    const value = reviewIncidentLabelSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.labels.review(actor, value.id, value.expectedRevision),
    );
  }
}
