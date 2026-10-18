import type { DeploymentsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function deploymentsClient(client: LocalAuthClient): DeploymentsClient {
  return {
    targets: (input) => client.query("deployments.list", input),
    history: (input) => client.query("deployments.history", input),
    detail: (input) => client.query("deployments.detail", input),
    coverage: (input) => client.query("deployments.coverage", input),
  };
}
