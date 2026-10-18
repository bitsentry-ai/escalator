import {
  heartbeatPageSchema,
  heartbeatIdSchema,
  createHeartbeatSchema,
  updateHeartbeatSchema,
  disableHeartbeatSchema,
  heartbeatGrantPageSchema,
  issueHeartbeatGrantSchema,
  revokeHeartbeatGrantSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
import { heartbeatRequest } from "./request.js";
export const heartbeatsRouter = t.router({
  list: authenticated
    .input(heartbeatPageSchema)
    .query(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(heartbeatIdSchema)
    .query(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.get(ctx.actor, input)),
    ),
  create: authenticated
    .input(createHeartbeatSchema)
    .mutation(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.create(ctx.actor, input)),
    ),
  update: authenticated
    .input(updateHeartbeatSchema)
    .mutation(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.update(ctx.actor, input)),
    ),
  disable: authenticated
    .input(disableHeartbeatSchema)
    .mutation(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.disable(ctx.actor, input)),
    ),
  grants: authenticated
    .input(heartbeatGrantPageSchema)
    .query(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.grants(ctx.actor, input)),
    ),
  issueGrant: authenticated
    .input(issueHeartbeatGrantSchema)
    .mutation(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.issueGrant(ctx.actor, input)),
    ),
  revokeGrant: authenticated
    .input(revokeHeartbeatGrantSchema)
    .mutation(({ ctx, input }) =>
      heartbeatRequest(() => ctx.heartbeats.revokeGrant(ctx.actor, input)),
    ),
});
