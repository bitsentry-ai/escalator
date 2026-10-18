import type { DetectionClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function detectionClient(client: LocalAuthClient): DetectionClient {
  return {
    binding: (input) => client.query("detection.getBinding", input),
    configureBinding: (input) =>
      client.mutate("detection.configureBinding", input),
    policies: (input) => client.query("configuration.policies", input),
  };
}
