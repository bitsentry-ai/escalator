import type { CreateModelSecretInput } from "@bitsentry-escalator/features/contracts";
import type { InvestigationSettingsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { incidentsClient } from "../incidents/incidents-client.js";
export function investigationSettingsClient(
  client: LocalAuthClient,
  canManageSecrets = false,
): InvestigationSettingsClient {
  const incidents = incidentsClient(client);
  return {
    ...(canManageSecrets
      ? {
          createSecret: (input: CreateModelSecretInput) =>
            client.mutate<{ id: string; name: string }>(
              "investigationSettings.createSecret",
              input,
            ),
        }
      : {}),
    services: (input) => incidents.services(input),
    environments: (input) => incidents.environments(input),
    get: (input) => client.query("investigationSettings.get", input),
    create: (input) => client.mutate("investigationSettings.create", input),
    update: (input) => client.mutate("investigationSettings.update", input),
    sources: (input) => client.query("investigationSettings.sources", input),
  };
}
