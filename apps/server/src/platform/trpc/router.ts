import { detectionRouter } from "../../features/detection/detection.router.js";
import { signalsRouter } from "../../features/signals/signals.router.js";
import { channelSecretsRouter } from "../../features/configuration/channel-secrets.router.js";
import { configurationRouter } from "../../features/configuration/configuration.router.js";
import { incidentsRouter } from "../../features/incidents/incidents.router.js";
import { t } from "./context.js";
import { authRouter } from "../auth/auth.router.js";
import { getEscalatorPackageInfo } from "@bitsentry-escalator/features/application";
import { servicesRouter } from "../../features/services/services.router.js";
export const appRouter = t.router({
  auth: authRouter,
  services: servicesRouter,
  signals: signalsRouter,
  detection: detectionRouter,
  incidents: incidentsRouter,
  configuration: configurationRouter,
  channelSecrets: channelSecretsRouter,
  packageInfo: t.procedure.query(() => getEscalatorPackageInfo()),
});
