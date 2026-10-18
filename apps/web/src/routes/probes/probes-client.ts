import { detectionClient } from "../detection/detection-client.js";
import type { ProbesClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function probesClient(client: LocalAuthClient): ProbesClient {
  return {
    ...detectionClient(client),
    get: (input) => client.query("probes.get", input),
    secretOptions: (input) => client.query("monitoringSecrets.list", input),
    createMonitoringSecret: (input) =>
      client.mutate("monitoringSecrets.create", input),
    list: (input) => client.query("probes.list", input),
    create: (input) => client.mutate("probes.create", input),
    update: (input) => client.mutate("probes.update", input),
    disable: (input) => client.mutate("probes.disable", input),
    history: (input) => client.query("probes.history", input),
    services: (input) => client.query("services.list", input),
    environments: (input) => client.query("incidents.environments", input),
  };
}
