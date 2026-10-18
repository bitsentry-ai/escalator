import type {
  RuleReportDetailInput,
  RuleReportDetail,
  RuleCatalogList,
  RuleCatalogView,
  RuleCatalogEntry,
  RuleCatalogHistoryQuery,
  RuleActivationHistory,
  RuleReviewReceipt,
  PortableRule,
  CreateRuleDraftInput,
  EditRuleDraftInput,
  AdoptRuleProposalInput,
  ReviewRuleInput,
  ActivateRuleInput,
  RetireRuleInput,
  ImportRuleDraftInput,
  CaptureRuleInput,
  RuleResultsList,
  RuleReplayResult,
  RuleProposalView,
  IncidentLabelsQuery,
  IncidentLabel,
  InvestigationSettings,
  CreateInvestigationSettingsInput,
} from "../../contracts/index.js";
import type { LabelsClient } from "../labels/client.js";
import type { IncidentCollection } from "../incidents-client.js";
export interface RulesClient extends Pick<
  LabelsClient,
  "services" | "environments" | "sources"
> {
  reportDetail(
    input: RuleReportDetailInput,
  ): Promise<RuleReportDetail | undefined>;
  access(): Promise<{ canPropose: boolean; canApprove: boolean }>;
  list(input: RuleCatalogList): Promise<IncidentCollection<RuleCatalogEntry>>;
  get(input: { id: string }): Promise<RuleCatalogView | undefined>;
  history(
    input: RuleCatalogHistoryQuery,
  ): Promise<{ items: RuleActivationHistory[]; next: number | null }>;
  export(input: { id: string }): Promise<PortableRule>;
  create(input: CreateRuleDraftInput): Promise<RuleCatalogEntry>;
  edit(input: EditRuleDraftInput): Promise<RuleCatalogEntry>;
  adopt(input: AdoptRuleProposalInput): Promise<RuleCatalogEntry>;
  import(input: ImportRuleDraftInput): Promise<RuleCatalogEntry>;
  review(input: ReviewRuleInput): Promise<RuleReviewReceipt>;
  activate(input: ActivateRuleInput): Promise<RuleCatalogEntry>;
  retire(input: RetireRuleInput): Promise<RuleCatalogEntry>;
  replay(input: CaptureRuleInput): Promise<{ id: string; snapshotId: string }>;
  propose(input: {
    sourceSnapshotId: string;
    originLabelId: string;
    profileId: string;
  }): Promise<{ id: string }>;
  replays(
    input: RuleResultsList,
  ): Promise<IncidentCollection<RuleReplayResult>>;
  replayResult(input: { id: string }): Promise<RuleReplayResult | undefined>;
  proposals(
    input: RuleResultsList,
  ): Promise<IncidentCollection<RuleProposalView>>;
  proposal(input: { id: string }): Promise<RuleProposalView | undefined>;
  labels(
    input: IncidentLabelsQuery,
  ): Promise<IncidentCollection<IncidentLabel>>;
  modelSettings(
    input: Pick<
      CreateInvestigationSettingsInput,
      "serviceId" | "environmentId"
    >,
  ): Promise<InvestigationSettings | undefined>;
}
