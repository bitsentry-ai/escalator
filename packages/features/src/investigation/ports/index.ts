import type {
  InvestigationScope,
  EvidenceQuery,
  InvestigationEvidence,
  UnavailableEvidence,
  ModelDestination,
  InvestigationLimits,
  InvestigationUsage,
  InvestigationReport,
  WorkspaceId,
} from "../../contracts/index.js";
/** Every network/read operation must honor cancellation and a bounded timeout. */
export interface OperationContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}
export interface EvidenceReader {
  /** Bind source to this incident's service/environment; never turn IDs into arbitrary URLs.
   * Return redacted text and scoped provenance. Enforce byte/row limits before materializing
   * a remote response. Missing data is not a successful empty read.
   */
  read(
    scope: InvestigationScope,
    query: EvidenceQuery,
    context: OperationContext & { maxBytes: number },
  ): Promise<
    | {
        status: "available";
        items: InvestigationEvidence[];
        truncated: boolean;
      }
    | { status: "unavailable"; unavailable: UnavailableEvidence }
  >;
}
export interface InvestigationClock {
  /** Report metadata only. Persistence uses database time for lease decisions. */
  now(): Date;
  /** Monotonic milliseconds. Wall-clock corrections cannot extend a budget. */
  monotonicMs(): number;
}
export interface Cancellation {
  readonly signal: AbortSignal;
  throwIfCancelled(): void;
}
export type BudgetResource =
  | "modelCalls"
  | "evidenceReads"
  | "evidenceBytes"
  | "outputTokens"
  | "traceEvents";
export interface Budget {
  readonly limits: Readonly<InvestigationLimits>;
  /** Atomic within a run. Invalid/over-budget charges fail without changing counters. */
  consume(resource: BudgetResource, amount: number): boolean;
  /** Throws on exhausted duration/cancellation before starting further work. */
  checkpoint(): void;
  remainingMs(): number;
  snapshot(): InvestigationUsage;
}
/** Profile access is service/environment-scoped, shared by investigation and rule proposals. */
export type ModelScope = Pick<
  InvestigationScope,
  "workspaceId" | "serviceId" | "environmentId"
>;
/** Resolve only configured profiles. Never accept provider keys/URLs from untrusted input. */
export interface ModelResolver {
  resolve(
    scope: ModelScope,
    profileId: string,
    context: OperationContext,
  ): Promise<ResolvedModel>;
}
export interface ResolvedModel {
  readonly destination: ModelDestination;
  /** No hidden retries, provider fallback or automatic tool execution.
   * Callers validate workflow-specific structured output before using it.
   */
  generate(
    request: ModelGenerationRequest,
    context: OperationContext,
  ): Promise<ModelGenerationResponse>;
}
export interface ModelGenerationRequest {
  readonly instruction: string;
  /** Bounded untrusted context, separate from system instructions; never executable. */
  readonly input: string;
  readonly maxOutputTokens: number;
}
export interface ModelGenerationResponse {
  text: string;
  /** Token-limited output remains partial; missing provider metadata stays explicit. */
  completion: "stop" | "length" | "unknown";
  /** Unknown usage stays explicit; the caller must charge its reserved output ceiling. */
  usage: { outputTokens: number | null };
}
export interface InvestigationClaim {
  readonly id: string;
  readonly scope: InvestigationScope;
  readonly runtimeId: string;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
  readonly attempt: number;
  readonly profileId: string;
  readonly limits: InvestigationLimits;
  readonly sources: readonly EvidenceQuery[];
}
export interface InvestigationTraceEvent {
  sequence: number;
  at: string;
  kind:
    | "started"
    | "evidence_read"
    | "model_call"
    | "budget_exhausted"
    | "cancelled"
    | "finished";
  /** Structured metadata only: no credentials, raw prompts or raw exceptions. */
  evidenceIds: string[];
  unavailableReason?: UnavailableEvidence["reason"];
  usage: InvestigationUsage;
}
export interface TraceWriter {
  /** Scope/runtime/token AND a live lease fence every append. Duplicate sequences are
   * idempotent; conflicting content is rejected. Return false for a stale claim.
   */
  append(
    claim: InvestigationClaim,
    event: InvestigationTraceEvent,
  ): Promise<boolean>;
}
/** Created by incident logic from trusted configuration, never by the model. */
export interface InvestigationIntent {
  id: string;
  scope: InvestigationScope;
  idempotencyKey: string;
  profileId: string;
  limits: InvestigationLimits;
  sources: EvidenceQuery[];
}
export interface InvestigationIntentWriter {
  /** Joins the host incident/page transaction. Duplicate intent must not restart
   * an investigation or replace its captured profile, source allowlist or limits.
   * Persistence assigns creation time from its transaction clock.
   */
  enqueue(intent: InvestigationIntent): Promise<"inserted" | "duplicate">;
}
export interface InvestigationRunResult {
  report: InvestigationReport;
  /** Redacted snapshots that produced the report; persist atomically with its references. */
  evidence: InvestigationEvidence[];
}
export interface InvestigationRepository {
  /** Commit a short transaction before network I/O. Host authenticates runtime/workspace.
   * Refuse stale runtime bindings. No cross-workspace discovery.
   */
  claim(input: {
    workspaceId: WorkspaceId;
    runtimeId: string;
    claimToken: string;
    leaseMs: number;
  }): Promise<InvestigationClaim | undefined>;
  /** Compare persisted runtime/token AND database expiry, not caller leaseExpiresAt. */
  heartbeat(
    claim: InvestigationClaim,
    leaseMs: number,
  ): Promise<{ leaseExpiresAt: string } | undefined>;
  /** Report, redacted evidence snapshots and terminal state commit atomically.
   * Every reference must match a supplied snapshot. Scope/id must match the claim.
   * An expired claim cannot publish even before it has been reclaimed.
   */
  publish(
    claim: InvestigationClaim,
    result: InvestigationRunResult,
  ): Promise<boolean>;
  /** Human reads remain workspace-scoped and authorized by the host. */
  get(
    scope: InvestigationScope,
    id: string,
  ): Promise<InvestigationReport | undefined>;
  /** Read only persisted redacted snapshots; apply the same human scope authorization. */
  getEvidence(
    scope: InvestigationScope,
    id: string,
  ): Promise<InvestigationEvidence[]>;
}
