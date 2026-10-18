import { t } from "./context.js";
import { authRouter } from "../auth/auth.router.js";
import { getEscalatorPackageInfo } from "@bitsentry-escalator/features/application";
import { servicesRouter } from "../../features/services/services.router.js";
export const appRouter = t.router({
  auth: authRouter,
  services: servicesRouter,
  packageInfo: t.procedure.query(() => getEscalatorPackageInfo()),
});
