import { initTRPC } from "@trpc/server";
import { getEscalatorPackageInfo } from "@bitsentry-escalator/features/application";
const t = initTRPC.create();
export const appRouter = t.router({
  packageInfo: t.procedure.query(() => getEscalatorPackageInfo()),
});
