import { probeRequest } from "./request.js";
import {
  createProbeSchema,
  updateProbeSchema,
  disableProbeSchema,
  probeIdInputSchema,
  probePageSchema,
  probeHistorySchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
export const probesRouter = t.router({
  list: authenticated
    .input(probePageSchema)
    .query(({ ctx, input }) =>
      probeRequest(() => ctx.probes.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(probeIdInputSchema)
    .query(({ ctx, input }) =>
      probeRequest(() => ctx.probes.get(ctx.actor, input)),
    ),
  history: authenticated
    .input(probeHistorySchema)
    .query(({ ctx, input }) =>
      probeRequest(() => ctx.probes.history(ctx.actor, input)),
    ),
  create: authenticated
    .input(createProbeSchema)
    .mutation(({ ctx, input }) =>
      probeRequest(() => ctx.probes.create(ctx.actor, input)),
    ),
  update: authenticated
    .input(updateProbeSchema)
    .mutation(({ ctx, input }) =>
      probeRequest(() => ctx.probes.update(ctx.actor, input)),
    ),
  disable: authenticated
    .input(disableProbeSchema)
    .mutation(({ ctx, input }) =>
      probeRequest(() => ctx.probes.disable(ctx.actor, input)),
    ),
});
