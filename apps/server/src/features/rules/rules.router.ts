import {
  ruleReportDetailInputSchema,
  ruleCatalogListSchema,
  ruleCatalogIdSchema,
  ruleCatalogHistoryQuerySchema,
  createRuleDraftSchema,
  editRuleDraftSchema,
  adoptRuleProposalSchema,
  importRuleDraftSchema,
  reviewRuleSchema,
  activateRuleSchema,
  retireRuleSchema,
  captureRuleSchema,
  ruleProposalRequestSchema,
  ruleResultsListSchema,
  ruleResultIdSchema,
} from "@bitsentry-escalator/features/contracts";
import { authenticated } from "../../platform/trpc/authenticated.js";
import { t } from "../../platform/trpc/context.js";
import { ruleRequest } from "./request.js";
export const rulesRouter = t.router({
  reportDetail: authenticated
    .input(ruleReportDetailInputSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.results.detail(ctx.actor, input)),
    ),
  access: authenticated.query(({ ctx }) => ctx.rules.access(ctx.actor)),
  list: authenticated
    .input(ruleCatalogListSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.catalog.list(ctx.actor, input)),
    ),
  get: authenticated
    .input(ruleCatalogIdSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.catalog.get(ctx.actor, input)),
    ),
  history: authenticated
    .input(ruleCatalogHistoryQuerySchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.catalog.history(ctx.actor, input)),
    ),
  export: authenticated
    .input(ruleCatalogIdSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.catalog.export(ctx.actor, input)),
    ),
  create: authenticated
    .input(createRuleDraftSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.create(ctx.actor, input)),
    ),
  edit: authenticated
    .input(editRuleDraftSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.edit(ctx.actor, input)),
    ),
  adopt: authenticated
    .input(adoptRuleProposalSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.adopt(ctx.actor, input)),
    ),
  import: authenticated
    .input(importRuleDraftSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.import(ctx.actor, input)),
    ),
  review: authenticated
    .input(reviewRuleSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.activation.review(ctx.actor, input)),
    ),
  activate: authenticated
    .input(activateRuleSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.activation.activate(ctx.actor, input)),
    ),
  retire: authenticated
    .input(retireRuleSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.activation.retire(ctx.actor, input)),
    ),
  replay: authenticated
    .input(captureRuleSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.replay(ctx.actor, input)),
    ),
  propose: authenticated
    .input(ruleProposalRequestSchema)
    .mutation(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.propose(ctx.actor, input)),
    ),
  replays: authenticated
    .input(ruleResultsListSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.results.replays(ctx.actor, input)),
    ),
  replayResult: authenticated
    .input(ruleResultIdSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.results.replay(ctx.actor, input)),
    ),
  proposals: authenticated
    .input(ruleResultsListSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.results.proposals(ctx.actor, input)),
    ),
  proposal: authenticated
    .input(ruleResultIdSchema)
    .query(({ ctx, input }) =>
      ruleRequest(() => ctx.rules.results.proposal(ctx.actor, input)),
    ),
});
