import { TRPCError } from "@trpc/server";
import {
  createChannelSecretSchema,
  channelSecretOptionsSchema,
  configurationPageSchema,
  hasCapability,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
const administrator = authenticated.use(({ ctx, next }) => {
  if (!hasCapability(ctx.actor.role, "secret:manage"))
    throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
/** Write-only credential values; only safe metadata leaves this transport. */
export const channelSecretsRouter = t.router({
  list: administrator
    .input(configurationPageSchema)
    .output(channelSecretOptionsSchema)
    .query(({ ctx, input }) =>
      ctx.secretWriter
        .list(ctx.actor, input, true)
        .then((page) =>
          channelSecretOptionsSchema.parse({ ...page, available: true }),
        ),
    ),
  create: administrator
    .input(createChannelSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const bytes = Buffer.from(JSON.stringify(input.credentials), "utf8");
      try {
        const value = await ctx.secretWriter.create(
          ctx.actor,
          input.name,
          bytes,
          input.channel,
        );
        return { id: value.id, name: value.name, channel: input.channel };
      } finally {
        bytes.fill(0);
      }
    }),
});
