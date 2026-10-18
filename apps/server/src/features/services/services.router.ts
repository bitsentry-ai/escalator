import { authenticated } from "../../platform/trpc/authenticated.js";
import {
  createServiceSchema,
  listServicesSchema,
  serviceIdSchema,
} from "@bitsentry-escalator/features/contracts";
import { t } from "../../platform/trpc/context.js";
export const servicesRouter = t.router({
  list: authenticated
    .input(listServicesSchema)
    .query(({ ctx, input }) => ctx.services.listServices(ctx.actor, input)),
  create: authenticated
    .input(createServiceSchema)
    .mutation(({ ctx, input }) => ctx.services.createService(ctx.actor, input)),
  get: authenticated
    .input(serviceIdSchema)
    .query(({ ctx, input }) => ctx.services.getService(ctx.actor, input)),
});
