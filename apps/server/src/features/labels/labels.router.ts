import {
  incidentLabelsQuerySchema,
  incidentLabelIdSchema,
  incidentLabelInputSchema,
  editIncidentLabelSchema,
  reviewIncidentLabelSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
import { labelRequest } from "./request.js";
export const labelsRouter = t.router({
  list: authenticated
    .input(incidentLabelsQuerySchema)
    .query(({ ctx, input }) =>
      labelRequest(() => ctx.labels.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(incidentLabelIdSchema)
    .query(({ ctx, input }) =>
      labelRequest(() => ctx.labels.get(ctx.actor, input)),
    ),
  create: authenticated
    .input(incidentLabelInputSchema)
    .mutation(({ ctx, input }) =>
      labelRequest(() => ctx.labels.create(ctx.actor, input)),
    ),
  edit: authenticated
    .input(editIncidentLabelSchema)
    .mutation(({ ctx, input }) =>
      labelRequest(() => ctx.labels.edit(ctx.actor, input)),
    ),
  review: authenticated
    .input(reviewIncidentLabelSchema)
    .mutation(({ ctx, input }) =>
      labelRequest(() => ctx.labels.review(ctx.actor, input)),
    ),
});
