import { TRPCError } from "@trpc/server";
import {
  createSignalSourceSchema,
  updateSignalSourceSchema,
  signalSourceIdSchema,
  signalSourcePageSchema,
  issueSignalTokenSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
export const signalsRouter = t.router({
  list: authenticated
    .input(signalSourcePageSchema)
    .query(({ ctx, input }) => ctx.signals.list(ctx.actor, input)),
  get: authenticated
    .input(signalSourceIdSchema)
    .query(({ ctx, input }) => ctx.signals.get(ctx.actor, input)),
  create: authenticated
    .input(createSignalSourceSchema)
    .mutation(({ ctx, input }) => ctx.signals.create(ctx.actor, input)),
  update: authenticated
    .input(updateSignalSourceSchema)
    .mutation(({ ctx, input }) => ctx.signals.update(ctx.actor, input)),
  issueToken: authenticated
    .input(issueSignalTokenSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.signals.issueToken(ctx.actor, input);
      } catch (error) {
        if (
          ["source_disabled", "source_kind"].includes(
            (error as { code?: string })?.code ?? "",
          )
        )
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Source cannot accept ingestion grants",
          });
        throw error;
      }
    }),
  revokeToken: authenticated
    .input(signalSourceIdSchema)
    .mutation(({ ctx, input }) => ctx.signals.revokeToken(ctx.actor, input)),
});
