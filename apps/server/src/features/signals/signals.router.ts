import { TRPCError } from "@trpc/server";
import {
  createSignalSourceSchema,
  listSignalTokensSchema,
  signalGrantPageSchema,
  createProviderSourceSchema,
  updateProviderSourceSchema,
  updateSignalSourceSchema,
  signalSourceIdSchema,
  signalSourcePageSchema,
  issueSignalTokenSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
async function ingestionGrant<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
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
}
export const signalsRouter = t.router({
  tokens: authenticated
    .input(listSignalTokensSchema)
    .output(signalGrantPageSchema)
    .query(({ ctx, input }) => ctx.signals.listTokens(ctx.actor, input)),
  createProvider: authenticated
    .input(createProviderSourceSchema)
    .mutation(({ ctx, input }) => ctx.signals.createProvider(ctx.actor, input)),
  updateProvider: authenticated
    .input(updateProviderSourceSchema)
    .mutation(({ ctx, input }) => ctx.signals.updateProvider(ctx.actor, input)),
  issueReceiver: authenticated
    .input(issueSignalTokenSchema)
    .mutation(({ ctx, input }) =>
      ingestionGrant(() => ctx.signals.issueReceiver(ctx.actor, input)),
    ),
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
      return ingestionGrant(() => ctx.signals.issueToken(ctx.actor, input));
    }),
  revokeToken: authenticated
    .input(signalSourceIdSchema)
    .mutation(({ ctx, input }) => ctx.signals.revokeToken(ctx.actor, input)),
});
