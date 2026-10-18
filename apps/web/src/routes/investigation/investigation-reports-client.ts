import type { InvestigationReportsClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function investigationReportsClient(
  client: LocalAuthClient,
): InvestigationReportsClient {
  return { read: (input) => client.query("investigationReports.get", input) };
}
