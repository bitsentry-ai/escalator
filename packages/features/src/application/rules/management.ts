import { RuleRequestError } from "./request-error.js";
import { hasCapability, type Actor } from "../../contracts/identity.js";
import {
  createRuleDraftSchema,
  editRuleDraftSchema,
  adoptRuleProposalSchema,
  importRuleDraftSchema,
  captureRuleSchema,
} from "../../contracts/rule-management.js";
import { detectionRuleSchema } from "../../contracts/rules.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleDrafts } from "./catalog.js";
import type { RuleCatalogQueries } from "./catalog-queries.js";
import type { ReviewRuleActivation } from "./activate.js";
import type { CaptureRuleReplay } from "./replay-capture.js";
import type { RuleProposalGeneration } from "./proposal-generation.js";
import type { RuleResultsQueries } from "./results-queries.js";
import { importRule } from "./export.js";
/** Both hosts bind authentication only; all rule actions remain shared. */
export class RuleManagement {
  constructor(
    readonly catalog: Pick<
      RuleCatalogQueries,
      "list" | "get" | "history" | "export"
    >,
    private readonly drafts: Pick<RuleDrafts, "create" | "edit" | "adopt">,
    readonly activation: Pick<
      ReviewRuleActivation,
      "review" | "activate" | "retire"
    >,
    private readonly capture: Pick<CaptureRuleReplay, "create">,
    private readonly proposals: Pick<RuleProposalGeneration, "request">,
    readonly results: Pick<
      RuleResultsQueries,
      "replays" | "replay" | "proposals" | "proposal" | "detail"
    >,
  ) {}
  access(actor: Actor) {
    return {
      canPropose: hasCapability(actor.role, "rule:propose"),
      canApprove: hasCapability(actor.role, "rule:approve"),
    };
  }
  create(actor: Actor, raw: unknown) {
    const input = createRuleDraftSchema.parse(raw);
    return this.drafts.create(actor, {
      title: input.title,
      definition: detectionRuleSchema.parse({
        ...input.definition,
        workspaceId: actor.workspaceId,
      }),
    });
  }
  edit(actor: Actor, raw: unknown) {
    const input = editRuleDraftSchema.parse(raw);
    return this.drafts.edit(actor, {
      ...input,
      definition: detectionRuleSchema.parse({
        ...input.definition,
        workspaceId: actor.workspaceId,
      }),
    });
  }
  adopt(actor: Actor, raw: unknown) {
    return this.drafts.adopt(actor, adoptRuleProposalSchema.parse(raw));
  }
  import(actor: Actor, raw: unknown) {
    const input = importRuleDraftSchema.parse(raw);
    return importRule(this.drafts, actor, input.document, input.mapping);
  }
  async propose(actor: Actor, raw: unknown) {
    const row = await this.proposals.request(actor, raw);
    return { id: row.id };
  }
  async replay(actor: Actor, raw: unknown) {
    const input = captureRuleSchema.parse(raw),
      found = await this.catalog.get(actor, { id: input.ruleId });
    if (!found) throw new PersistenceError("not_found");
    if (found.entry.revision !== input.expectedRevision)
      throw new RuleRequestError("CONFLICT", "Rule changed concurrently");
    // An edit after this read cannot alter the immutable version captured here.
    // Review later checks the current catalog revision and original sealed report.
    const run = await this.capture.create(actor, found.version, {
      firstDecisionAt: input.firstDecisionAt,
      lastDecisionAt: input.lastDecisionAt,
    });
    return { id: run.id, snapshotId: run.snapshotId };
  }
}
