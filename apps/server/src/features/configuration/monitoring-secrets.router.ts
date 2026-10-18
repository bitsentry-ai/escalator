import { TRPCError } from "@trpc/server";
import {
  createMonitoringSecretSchema,
  channelSecretOptionsSchema,
  configurationPageSchema,
  hasCapability,
} from "@bitsentry-escalator/features/contracts";
import { encodeMonitoringSecret } from "@bitsentry-escalator/features/application";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
const administrator = authenticated.use(({ ctx, next }) => {
  if (!hasCapability(ctx.actor.role, "secret:manage"))
    throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
export const monitoringSecretsRouter = t.router({
  list: administrator
    .input(configurationPageSchema)
    .output(channelSecretOptionsSchema)
    .query(({ ctx, input }) =>
      ctx.secretWriter
        .list(ctx.actor, input)
        .then((page) => ({ ...page, available: true })),
    ),
  create: administrator
    .input(createMonitoringSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const bytes = encodeMonitoringSecret(input);
      try {
        const value = await ctx.secretWriter.create(
          ctx.actor,
          input.name,
          bytes,
        );
        return { id: value.id, name: value.name };
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to store monitoring credential",
        });
      } finally {
        bytes.fill(0);
      }
    }),
});
