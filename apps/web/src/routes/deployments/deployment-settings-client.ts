import type { DeploymentSettingsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { incidentsClient } from "../incidents/incidents-client.js";
import { oncallClient } from "../oncall/oncall-client.js";
export function deploymentSettingsClient(
  client: LocalAuthClient,
): DeploymentSettingsClient {
  const incidents = incidentsClient(client),
    oncall = oncallClient(client);
  return {
    services: (input) => incidents.services(input),
    environments: (input) => incidents.environments(input),
    policies: (input) => incidents.policies(input),
    responders: (input) => oncall.responders(input),
    create: (input) => client.mutate("deployments.create", input),
    update: (input) => client.mutate("deployments.update", input),
    grants: (input) => client.query("deployments.grants", input),
    issue: (input) => client.mutate("deployments.issueGrant", input),
    revoke: (input) => client.mutate("deployments.revokeGrant", input),
  };
}
