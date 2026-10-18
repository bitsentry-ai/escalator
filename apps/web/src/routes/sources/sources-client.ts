import { detectionClient } from "../detection/detection-client.js";
import type { SourcesClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function sourcesClient(client: LocalAuthClient): SourcesClient {
  return {
    ...detectionClient(client),
    list: (input) => client.query("signals.list", input),
    create: (input) => client.mutate("signals.create", input),
    update: (input) => client.mutate("signals.update", input),
    createProvider: (input) => client.mutate("signals.createProvider", input),
    updateProvider: (input) => client.mutate("signals.updateProvider", input),
    grants: (input) => client.query("signals.tokens", input),
    issueToken: (input) => client.mutate("signals.issueToken", input),
    issueReceiver: (input) => client.mutate("signals.issueReceiver", input),
    revoke: (input) => client.mutate("signals.revokeToken", input),
    secretOptions: (input) => client.query("monitoringSecrets.list", input),
    createMonitoringSecret: (input) =>
      client.mutate("monitoringSecrets.create", input),
    services: (input) => client.query("services.list", input),
    environments: (input) => client.query("incidents.environments", input),
  };
}
