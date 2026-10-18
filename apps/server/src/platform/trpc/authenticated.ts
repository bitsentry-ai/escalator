import { TRPCError } from "@trpc/server";
import { responderIdSchema } from "@bitsentry-escalator/features/contracts";
import { t } from "./context.js";
export const authenticated = t.procedure
  .use(async ({ ctx, next }) => {
    if (!ctx.req.session.account) throw new TRPCError({ code: "UNAUTHORIZED" });
    try {
      const account = await ctx.auth.current(ctx.req.session.account);
      return await next({
        ctx: {
          ...ctx,
          actor: {
            workspaceId: ctx.workspaceId,
            responderId: responderIdSchema.parse(account.id),
            role: account.role,
          },
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "authentication_failed")
        throw new TRPCError({ code: "UNAUTHORIZED" });
      throw error;
    }
  })
  .use(async ({ next }) => {
    const result = await next();
    if (!result.ok) {
      const code = (result.error.cause as { code?: string } | undefined)?.code;
      if (code === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
      if (code === "forbidden") throw new TRPCError({ code: "FORBIDDEN" });
      if (code === "already_exists") throw new TRPCError({ code: "CONFLICT" });
      if (code === "paging_unavailable")
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Paging is unavailable",
        });
    }
    return result;
  });
