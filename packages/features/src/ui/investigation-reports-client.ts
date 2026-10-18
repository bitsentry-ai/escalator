import type { InvestigationView } from "../contracts/index.js";
/** Human tRPC reads; host authentication supplies organization/workspace scope. */
export interface InvestigationReportsClient {
  read(input: { id: string }): Promise<InvestigationView>;
}
