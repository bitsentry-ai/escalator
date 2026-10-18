import {
  replayCoverageQuerySchema,
  updateReplayRetentionSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
import { retentionRequest } from "./request.js";
export const retentionRouter = t.router({
  get: authenticated.query(({ ctx }) =>
    retentionRequest(() => ctx.retention.get(ctx.actor)),
  ),
  update: authenticated
    .input(updateReplayRetentionSchema)
    .mutation(({ ctx, input }) =>
      retentionRequest(() => ctx.retention.update(ctx.actor, input)),
    ),
  coverage: authenticated
    .input(replayCoverageQuerySchema)
    .query(({ ctx, input }) =>
      retentionRequest(() => ctx.retention.report(ctx.actor, input)),
    ),
});
