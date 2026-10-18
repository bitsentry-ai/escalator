import {
  detectionRuleSchema,
  type DetectionRule,
  type WorkspaceId,
} from "../../contracts/index.js";
import {
  ruleHistoryQuerySchema,
  type RuleHistoryQuery,
  type RuleHistorySnapshot,
} from "../../contracts/rule-history.js";
import { ruleWindowBounds } from "../../domain/rules/time.js";
import { ruleWindowFromHistory } from "./history-window.js";
export interface RuleHistoryRepository {
  /** One scoped database statement. Apply original-precision availability cutoffs
   * before projecting timestamps; missing historical provenance remains null.
   * Return complete=false on either bound, never a successful truncated prefix. */
  snapshot(
    scope: WorkspaceId,
    query: RuleHistoryQuery,
  ): Promise<RuleHistorySnapshot>;
}
export async function readRuleHistoryWindow(
  repository: RuleHistoryRepository,
  rawRule: DetectionRule,
  decisionAt: string,
  measurementHash: string,
) {
  const rule = detectionRuleSchema.parse(rawRule);
  const bounds = ruleWindowBounds(rule, decisionAt);
  const query = ruleHistoryQuerySchema.parse({
    serviceId: rule.serviceId,
    environmentId: rule.environmentId,
    kind: rule.selector.kind,
    streamId: rule.selector.streamId,
    startAt: new Date(bounds.start).toISOString(),
    endAt: new Date(bounds.end).toISOString(),
    visibleAt: decisionAt,
  });
  return ruleWindowFromHistory(
    rule,
    decisionAt,
    await repository.snapshot(rule.workspaceId, query),
    measurementHash,
  );
}
