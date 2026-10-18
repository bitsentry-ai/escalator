import type { PagingSettingsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { oncallClient } from "../oncall/oncall-client.js";
export function settingsClient(client: LocalAuthClient): PagingSettingsClient {
  return {
    ...oncallClient(client),
    storedPreview: (input) =>
      client.query("configuration.storedPreview", input),
    contacts: (input) => client.query("configuration.contacts", input),
    writeContact: (input) => client.mutate("configuration.writeContact", input),
    policies: (input) => client.query("configuration.policies", input),
    policy: (input) => client.query("configuration.policy", input),
    writePolicy: (input) => client.mutate("configuration.writePolicy", input),
    availability: (input) => client.query("configuration.availability", input),
    writeAvailability: (input) =>
      client.mutate("configuration.writeAvailability", input),
    previews: (input) => client.query("configuration.previews", input),
    secretOptions: (input) => client.query("channelSecrets.list", input),
    createSecret: (input) => client.mutate("channelSecrets.create", input),
  };
}
