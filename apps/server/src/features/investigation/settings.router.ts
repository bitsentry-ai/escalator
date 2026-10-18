import { ZodError } from "zod";
import { listInvestigationSources } from "@bitsentry-escalator/features/application";
import { TRPCError } from "@trpc/server";
import {
  investigationSourceOptionsInputSchema,
  investigationSourceOptionsSchema,
  createInvestigationSettingsSchema,
  updateInvestigationSettingsSchema,
  modelProfileSchema,
  createModelSecretSchema,
  hasCapability,
} from "@bitsentry-escalator/features/contracts";
import { encodeModelSecret } from "@bitsentry-escalator/features/investigation";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
async function request<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ZodError)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid investigation configuration",
      });
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "forbidden") throw new TRPCError({ code: "FORBIDDEN" });
    if (code === "not_found")
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Investigation configuration or binding is unavailable",
      });
    if (code === "conflict")
      throw new TRPCError({
        code: "CONFLICT",
        message: "Investigation settings changed; reload before saving",
      });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to change investigation settings",
    });
  }
}
export const investigationSettingsRouter = t.router({
  sources: authenticated
    .input(investigationSourceOptionsInputSchema)
    .output(investigationSourceOptionsSchema)
    .query(({ ctx, input }) =>
      request(() =>
        listInvestigationSources(
          ctx.actor,
          input,
          ctx.investigationSourceCatalog,
        ),
      ),
    ),
  get: authenticated
    .input(modelProfileSchema.shape.scope.omit({ workspaceId: true }))
    .query(({ ctx, input }) =>
      request(() => ctx.investigationSettings.get(ctx.actor, input)),
    ),
  create: authenticated
    .input(createInvestigationSettingsSchema)
    .mutation(({ ctx, input }) =>
      request(() => ctx.investigationSettings.create(ctx.actor, input)),
    ),
  update: authenticated
    .input(updateInvestigationSettingsSchema)
    .mutation(({ ctx, input }) =>
      request(() => ctx.investigationSettings.update(ctx.actor, input)),
    ),
  createSecret: authenticated
    .input(createModelSecretSchema)
    .mutation(async ({ ctx, input }) => {
      if (!hasCapability(ctx.actor.role, "secret:manage"))
        throw new TRPCError({ code: "FORBIDDEN" });
      const bytes = encodeModelSecret(input);
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
          message: "Unable to store model credential",
        });
      } finally {
        bytes.fill(0);
      }
    }),
});
