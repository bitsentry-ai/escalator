export type * from "./ports/index.js";
export {
  createProviderLanguageModel,
  UnsupportedModelProviderError,
  type ProviderModelConfiguration,
} from "./models/provider-model-factory.js";
export {
  ModelDestinationPolicy,
  ModelDestinationError,
  type ModelLocation,
  type ModelEgressRules,
} from "./models/destination-policy.js";
export {
  BoundedModelHttp,
  ModelTransportError,
  type ModelTransportFailure,
  type ModelHttpLimits,
} from "./models/http.js";
export {
  modelProfileSchema,
  type ModelProfile,
  type ModelProfileReader,
} from "./models/profiles.js";
export {
  ScopedModelResolver,
  ModelExecutionError,
  type ModelFailure,
} from "./models/resolver.js";
export type {
  LegacyDiagnosisEvidenceRequest,
  LegacyDiagnosisSourceType,
  LegacyDiagnosisEvidenceQuerySummary,
  LegacyDiagnosisEvidenceCollection,
} from "./evidence/legacy-types.js";
export { buildLegacyEvidenceVerificationPrompt } from "./evidence/legacy-prompt.js";
export {
  truncateLegacyEvidenceText,
  legacyEvidenceValues,
} from "./evidence/legacy-values.js";
export { buildLegacyEvidenceQuery } from "./evidence/legacy-queries.js";
export {
  getWazuhHttpFacts,
  HTTP_EVIDENCE_GUIDANCE,
} from "./evidence/wazuh-http-facts.js";
export { ValidatedEvidenceReader } from "./evidence/validated-reader.js";
export {
  redactEvidence,
  redactEvidenceText,
  type RedactedEvidenceText,
} from "./evidence/redaction.js";
export {
  wazuhEvidenceBindingSchema,
  prepareWazuhEvidence,
  normalizeWazuhEvidence,
  WazuhEvidenceError,
  type WazuhEvidenceBinding,
} from "./evidence/wazuh.js";
export {
  InvestigationBudget,
  InvestigationBudgetError,
  systemInvestigationClock,
} from "./orchestration/budget.js";
export {
  runInvestigation,
  type InvestigationDependencies,
} from "./orchestration/run.js";
export {
  investigationClaimSchema,
  validateInvestigationResult,
  validateInvestigationTrace,
  InvalidInvestigationResult,
} from "./orchestration/claims.js";
export {
  executeInvestigationClaim,
  defaultInvestigationLeaseOptions,
  type InvestigationLeaseOptions,
  type InvestigationExecution,
  type InvestigationExecutionOutcome,
} from "./orchestration/lease-runner.js";

export * from "./orchestration/capture.js";

export * from "./models/credential-projection.js";

export { firstPageInvestigation } from "./orchestration/first-page.js";

export {
  normalizeNativeEvidence,
  nativeEvidenceRowSchema,
  type NativeEvidenceRow,
} from "./evidence/native.js";

export {
  InvestigationConsumer,
  type InvestigationConsumerOptions,
} from "./orchestration/consumer.js";

export {
  repositoryComparisonSchema,
  normalizeGithubDiff,
  type RepositoryComparison,
} from "./evidence/github-diff.js";
export {
  GithubDiffHttp,
  GithubDiffError,
  type GithubDiffFailure,
} from "./evidence/github-http.js";
