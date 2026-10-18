import {
  manualIncidentInputSchema,
  incidentPageInputSchema,
  incidentListInputSchema,
  createEnvironmentInputSchema,
  incidentDetailInputSchema,
  incidentDeliveriesInputSchema,
  deliveryAttemptsInputSchema,
} from "@bitsentry-escalator/features/contracts";
import { t } from "../../platform/trpc/context.js";
import { authenticated } from "../../platform/trpc/authenticated.js";
export const incidentsRouter = t.router({
  list: authenticated
    .input(incidentListInputSchema)
    .query(({ ctx, input }) => ctx.incidents.list(ctx.actor, input)),
  create: authenticated
    .input(manualIncidentInputSchema)
    .mutation(({ ctx, input }) => ctx.incidents.create(ctx.actor, input)),
  detail: authenticated
    .input(incidentDetailInputSchema)
    .query(({ ctx, input }) => ctx.incidents.detail(ctx.actor, input)),
  deliveries: authenticated
    .input(incidentDeliveriesInputSchema)
    .query(({ ctx, input }) => ctx.incidents.deliveries(ctx.actor, input)),
  attempts: authenticated
    .input(deliveryAttemptsInputSchema)
    .query(({ ctx, input }) => ctx.incidents.attempts(ctx.actor, input)),
  environments: authenticated
    .input(incidentPageInputSchema)
    .query(({ ctx, input }) =>
      ctx.incidents.listEnvironments(ctx.actor, input),
    ),
  createEnvironment: authenticated
    .input(createEnvironmentInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.incidents.createEnvironment(ctx.actor, input),
    ),
});
