import {
  ruleCatalogEntrySchema,
  type RuleCatalogEntry,
} from "../../contracts/rule-catalog.js";
import { detectionRuleVersionSchema } from "../../contracts/rule-state.js";
import {
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleBacktestTransaction } from "./backtest-ports.js";
import { assertProposalReports } from "./proposal-readiness.js";
/** Hosts lock the proposal before replay rows and supply the catalog's immutable
 * first version. Later human revisions keep provenance without becoming AI edits. */
export async function assertRuleCatalogProposal(
  tx: RuleBacktestTransaction,
  rawEntry: RuleCatalogEntry,
  rawInitial: unknown,
  rawProposal: RuleProposal,
): Promise<void> {
  const entry = ruleCatalogEntrySchema.parse(rawEntry),
    initial = detectionRuleVersionSchema.parse(rawInitial),
    proposal = ruleProposalSchema.parse(rawProposal);
  if (
    entry.workspaceId !== tx.workspaceId ||
    initial.definition.workspaceId !== tx.workspaceId ||
    proposal.workspaceId !== tx.workspaceId ||
    entry.originProposalId !== proposal.id ||
    entry.id !== proposal.candidateId ||
    initial.id !== entry.id ||
    initial.revision !== 1 ||
    initial.definition.serviceId !== entry.serviceId ||
    initial.definition.environmentId !== entry.environmentId
  )
    throw new PersistenceError("scope_violation");
  if (
    proposal.status !== "ready" ||
    !proposal.generation ||
    JSON.stringify(initial) !== JSON.stringify(proposal.generation.candidate)
  )
    throw new Error("Rule origin is not an evaluated proposal");
  await assertProposalReports(tx, proposal);
}
