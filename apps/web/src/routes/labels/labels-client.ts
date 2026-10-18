import type { LabelsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { incidentsClient } from "../incidents/incidents-client.js";
export function labelsClient(client: LocalAuthClient): LabelsClient {
  const incidents = incidentsClient(client);
  return {
    services: (input) => incidents.services(input),
    environments: (input) => incidents.environments(input),
    list: (input) => client.query("labels.list", input),
    get: (input) => client.query("labels.get", input),
    create: (input) => client.mutate("labels.create", input),
    edit: (input) => client.mutate("labels.edit", input),
    review: (input) => client.mutate("labels.review", input),
    sources: (input) => client.query("investigationSettings.sources", input),
  };
}
