import { TRPCError } from "@trpc/server";
import {
  incidentDetailInputSchema,
  investigationViewSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
export const investigationReportsRouter = t.router({
  get: authenticated
    .input(incidentDetailInputSchema)
    .output(investigationViewSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.investigationReports.read(ctx.actor, input);
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code === "forbidden") throw new TRPCError({ code: "FORBIDDEN" });
        if (code === "not_found")
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Incident is unavailable",
          });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to read investigation report",
        });
      }
    }),
});
