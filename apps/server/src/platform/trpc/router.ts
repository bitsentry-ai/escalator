import { t } from "./context.js";
import { authRouter } from "../auth/auth.router.js";
import { getEscalatorPackageInfo } from "@bitsentry-escalator/features/application";
export const appRouter = t.router({
  auth: authRouter,
  packageInfo: t.procedure.query(() => getEscalatorPackageInfo()),
});
