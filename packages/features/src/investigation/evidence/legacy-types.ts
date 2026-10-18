/** Structural snapshot for the existing diagnosis workflow; no CE or host dependency. */
export interface LegacyDiagnosisEvidenceRequest {
  entryId?: number;
  entryIndex?: string;
  ruleId?: string;
  ruleDescription: string;
  ruleLevel?: number;
  ruleGroups?: string[];
  category?: string;
  entrySource: Record<string, unknown>;
  entryTimestamp: Date;
  agentName?: string;
  agentIp?: string;
  diagnosisText: string;
}
export type LegacyDiagnosisSourceType =
  | "sentry"
  | "wazuh"
  | "posthog"
  | "github";
export interface LegacyDiagnosisEvidenceQuerySummary {
  sourceType: LegacyDiagnosisSourceType | "telemetry" | "unknown";
  sourceName?: string;
  query: string;
  resultCount: number;
  hasMore: boolean;
  output: string;
  error?: string;
}
export interface LegacyDiagnosisEvidenceCollection {
  sourceType?: LegacyDiagnosisSourceType;
  sourceId?: string;
  sourceName?: string;
  providerObject: Record<string, unknown>;
  queries: LegacyDiagnosisEvidenceQuerySummary[];
  toolsUsed: string[];
}
