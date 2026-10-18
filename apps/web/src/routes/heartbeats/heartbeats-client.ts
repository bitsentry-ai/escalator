import type { HeartbeatsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
import { detectionClient } from "../detection/detection-client.js";
export function heartbeatsClient(client: LocalAuthClient): HeartbeatsClient {
  return {
    ...detectionClient(client),
    list: (input) => client.query("heartbeats.list", input),
    get: (input) => client.query("heartbeats.get", input),
    create: (input) => client.mutate("heartbeats.create", input),
    update: (input) => client.mutate("heartbeats.update", input),
    disable: (input) => client.mutate("heartbeats.disable", input),
    grants: (input) => client.query("heartbeats.grants", input),
    issueGrant: (input) => client.mutate("heartbeats.issueGrant", input),
    revokeGrant: (input) => client.mutate("heartbeats.revokeGrant", input),
    services: (input) => client.query("services.list", input),
    environments: (input) => client.query("incidents.environments", input),
  };
}
