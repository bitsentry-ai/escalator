import { metricRequest } from "./request.js";
import {
  createMetricSchema,
  updateMetricSchema,
  disableMetricSchema,
  metricIdInputSchema,
  metricPageSchema,
  metricHistorySchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
export const metricsRouter = t.router({
  list: authenticated
    .input(metricPageSchema)
    .query(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(metricIdInputSchema)
    .query(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.get(ctx.actor, input)),
    ),
  history: authenticated
    .input(metricHistorySchema)
    .query(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.history(ctx.actor, input)),
    ),
  create: authenticated
    .input(createMetricSchema)
    .mutation(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.create(ctx.actor, input)),
    ),
  update: authenticated
    .input(updateMetricSchema)
    .mutation(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.update(ctx.actor, input)),
    ),
  disable: authenticated
    .input(disableMetricSchema)
    .mutation(({ ctx, input }) =>
      metricRequest(() => ctx.metrics.disable(ctx.actor, input)),
    ),
});
