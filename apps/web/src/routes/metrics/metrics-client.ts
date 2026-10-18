import type { MetricsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { detectionClient } from "../detection/detection-client.js";
export function metricsClient(client: LocalAuthClient): MetricsClient {
  return {
    ...detectionClient(client),
    list: (input) => client.query("metrics.list", input),
    get: (input) => client.query("metrics.get", input),
    create: (input) => client.mutate("metrics.create", input),
    update: (input) => client.mutate("metrics.update", input),
    disable: (input) => client.mutate("metrics.disable", input),
    history: (input) => client.query("metrics.history", input),
    secretOptions: (input) => client.query("monitoringSecrets.list", input),
    createMonitoringSecret: (input) =>
      client.mutate("monitoringSecrets.create", input),
    services: (input) => client.query("services.list", input),
    environments: (input) => client.query("incidents.environments", input),
  };
}
