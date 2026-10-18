import type { IncidentsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function incidentsClient(client: LocalAuthClient): IncidentsClient {
  return {
    list: (input) => client.query("incidents.list", input),
    detail: (input) => client.query("incidents.detail", input),
    create: (input) => client.mutate("incidents.create", input),
    resolve: (input) => client.mutate("incidents.resolve", input),
    deliveries: (input) => client.query("incidents.deliveries", input),
    attempts: (input) => client.query("incidents.attempts", input),
    services: (input) => client.query("services.list", input),
    environments: (input) => client.query("incidents.environments", input),
    policies: (input) => client.query("incidents.policies", input),
    createEnvironment: (input) =>
      client.mutate("incidents.createEnvironment", input),
  };
}
