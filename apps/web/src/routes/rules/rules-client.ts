import type { RulesClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { labelsClient } from "../labels/labels-client.js";
import { investigationSettingsClient } from "../investigation/investigation-settings-client.js";
export function rulesClient(client: LocalAuthClient): RulesClient {
  const labels = labelsClient(client),
    settings = investigationSettingsClient(client);
  return {
    services: (input) => labels.services(input),
    environments: (input) => labels.environments(input),
    sources: (input) => labels.sources(input),
    labels: (input) => labels.list(input),
    modelSettings: (input) => settings.get(input),
    reportDetail: (input) => client.query("rules.reportDetail", input),
    access: () => client.query("rules.access"),
    list: (input) => client.query("rules.list", input),
    get: (input) => client.query("rules.get", input),
    history: (input) => client.query("rules.history", input),
    export: (input) => client.query("rules.export", input),
    create: (input) => client.mutate("rules.create", input),
    edit: (input) => client.mutate("rules.edit", input),
    adopt: (input) => client.mutate("rules.adopt", input),
    import: (input) => client.mutate("rules.import", input),
    review: (input) => client.mutate("rules.review", input),
    activate: (input) => client.mutate("rules.activate", input),
    retire: (input) => client.mutate("rules.retire", input),
    replay: (input) => client.mutate("rules.replay", input),
    propose: (input) => client.mutate("rules.propose", input),
    replays: (input) => client.query("rules.replays", input),
    replayResult: (input) => client.query("rules.replayResult", input),
    proposals: (input) => client.query("rules.proposals", input),
    proposal: (input) => client.query("rules.proposal", input),
  };
}
