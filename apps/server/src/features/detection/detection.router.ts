import {
  detectionBindingKeySchema,
  writeDetectionBindingSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
export const detectionRouter = t.router({
  getBinding: authenticated
    .input(detectionBindingKeySchema)
    .query(({ ctx, input }) => ctx.detection.get(ctx.actor, input)),
  configureBinding: authenticated
    .input(writeDetectionBindingSchema)
    .mutation(({ ctx, input }) => ctx.detection.configure(ctx.actor, input)),
});
