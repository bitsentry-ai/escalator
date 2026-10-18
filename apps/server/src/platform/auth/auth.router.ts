import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  roleSchema,
  responderSchema,
} from "@bitsentry-escalator/features/contracts";
import { t, type AppContext } from "../trpc/context.js";
import { loginSchema } from "./schemas.js";
import {
  csrfToken,
  destroySession,
  establishSession,
  saveSession,
  resetSession,
} from "./session-security.js";
const password = z.string().min(1).max(1024);
const grant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const factor = z.string().max(64);
function proof(ctx: AppContext) {
  if (!ctx.req.session.account) throw new TRPCError({ code: "UNAUTHORIZED" });
  return ctx.req.session.account;
}
function ip(ctx: AppContext) {
  if (!ctx.req.ip) throw new TRPCError({ code: "UNAUTHORIZED" });
  return ctx.req.ip;
}
const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (
    !result.ok &&
    (result.error.cause as { code?: string } | undefined)?.code ===
      "authentication_failed"
  )
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication failed",
    });
  return result;
});
export const authRouter = t.router({
  session: procedure.query(async ({ ctx }) => {
    let current;
    if (ctx.req.session.account) {
      try {
        current = await ctx.auth.current(ctx.req.session.account);
      } catch (error) {
        if ((error as { code?: string })?.code !== "authentication_failed")
          throw error;
        await resetSession(ctx.req);
      }
    }
    if (!current) await ctx.auth.initializeSession(ip(ctx));
    const csrf = csrfToken(ctx.req);
    await saveSession(ctx.req);
    return {
      csrf,
      user: current
        ? {
            id: current.id,
            login: current.login,
            displayName: current.displayName,
            timeZone: current.timeZone,
            role: current.role,
            totpEnabled: current.totpSecretId !== null,
          }
        : null,
    };
  }),
  login: procedure
    .input(
      z.strictObject({
        login: loginSchema,
        password,
        factor: factor.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.auth.login(ip(ctx), input);
      await establishSession(ctx.req, account);
      return { csrf: csrfToken(ctx.req) };
    }),
  register: procedure
    .input(
      z.strictObject({
        token: grant,
        login: loginSchema,
        password,
        displayName: responderSchema.shape.displayName,
        timeZone: responderSchema.shape.timeZone,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.auth.register(ip(ctx), input);
      return { ok: true };
    }),
  invite: procedure
    .input(z.strictObject({ role: roleSchema }))
    .mutation(async ({ ctx, input }) => ({
      token: await ctx.auth.invite(ip(ctx), proof(ctx), input.role),
    })),
  beginTotp: procedure
    .input(z.strictObject({ password }))
    .mutation(({ ctx, input }) =>
      ctx.auth.beginTotp(ip(ctx), proof(ctx), input.password),
    ),
  enableTotp: procedure
    .input(z.strictObject({ token: z.string().regex(/^\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.auth.enableTotp(
        ip(ctx),
        proof(ctx),
        input.token,
      );
      await establishSession(ctx.req, result.proof);
      return { csrf: csrfToken(ctx.req), recoveryCodes: result.recoveryCodes };
    }),
  disableTotp: procedure
    .input(z.strictObject({ password, factor }))
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.auth.disableTotp(
        ip(ctx),
        proof(ctx),
        input.password,
        input.factor,
      );
      await establishSession(ctx.req, account);
      return { csrf: csrfToken(ctx.req) };
    }),
  recover: procedure
    .input(z.strictObject({ token: grant, password }))
    .mutation(async ({ ctx, input }) => {
      await ctx.auth.recover(ip(ctx), input.token, input.password);
      await destroySession(ctx.req);
      return { ok: true };
    }),
  logout: procedure.mutation(async ({ ctx }) => {
    await destroySession(ctx.req);
    return { ok: true };
  }),
});
