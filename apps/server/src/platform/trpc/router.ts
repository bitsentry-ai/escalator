import { retentionRouter } from "../../features/retention/retention.router.js";
import { monitoringSecretsRouter } from "../../features/configuration/monitoring-secrets.router.js";
import { heartbeatsRouter } from "../../features/heartbeats/heartbeats.router.js";
import { metricsRouter } from "../../features/metrics/metrics.router.js";
import { probesRouter } from "../../features/probes/probes.router.js";
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
  probes: probesRouter,
  metrics: metricsRouter,
  retention: retentionRouter,
  heartbeats: heartbeatsRouter,
  incidents: incidentsRouter,
  configuration: configurationRouter,
  channelSecrets: channelSecretsRouter,
  monitoringSecrets: monitoringSecretsRouter,
  packageInfo: t.procedure.query(() => getEscalatorPackageInfo()),
});
