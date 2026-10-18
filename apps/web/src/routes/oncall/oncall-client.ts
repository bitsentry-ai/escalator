import type { OnCallClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function oncallClient(client: LocalAuthClient): OnCallClient {
  return {
    schedules: (input) => client.query("configuration.schedules", input),
    schedule: (input) => client.query("configuration.schedule", input),
    writeSchedule: (input) =>
      client.mutate("configuration.writeSchedule", input),
    coverage: (input) => client.query("configuration.coverage", input),
    preview: (input) => client.mutate("configuration.preview", input),
    services: (input) => client.query("services.list", input),
    responders: (input) => client.query("configuration.responders", input),
  };
}
