import {
  investigationSourceOptionsInputSchema,
  investigationSourceOptionsSchema,
  type InvestigationSourceOptionsInput,
  type InvestigationSourceOptionsQuery,
  type InvestigationSourceOptions,
} from "../../contracts/investigation-source-options.js";
import {
  hasCapability,
  type Actor,
  type WorkspaceId,
} from "../../contracts/identity.js";
import { InvestigationSettingsError } from "./transaction.js";
export interface InvestigationSourceCatalog {
  /** Host filters by all three scope IDs, returns only metadata, and bounds rows before loading. */
  list(
    workspaceId: WorkspaceId,
    input: InvestigationSourceOptionsQuery,
  ): Promise<InvestigationSourceOptions>;
}
export async function listInvestigationSources(
  actor: Actor,
  input: InvestigationSourceOptionsInput,
  catalog: InvestigationSourceCatalog,
): Promise<InvestigationSourceOptions> {
  if (!hasCapability(actor.role, "service:read"))
    throw new InvestigationSettingsError("forbidden");
  const query = investigationSourceOptionsInputSchema.parse(input);
  const page = investigationSourceOptionsSchema.parse(
    await catalog.list(actor.workspaceId, query),
  );
  if (
    page.items.length > query.limit ||
    page.items.some(
      (item, index) =>
        item.kind !== query.kind ||
        (query.after !== undefined && item.sourceId <= query.after) ||
        (index > 0 && item.sourceId <= page.items[index - 1].sourceId),
    ) ||
    (page.next !== null && page.next !== page.items.at(-1)?.sourceId)
  )
    throw new Error("Invalid investigation source catalog page");
  return page;
}
