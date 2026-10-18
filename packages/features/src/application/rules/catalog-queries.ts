import { z } from "zod";
import {
  ruleCatalogListSchema,
  ruleCatalogIdSchema,
  ruleCatalogHistoryQuerySchema,
  ruleCatalogViewSchema,
  type RuleCatalogView,
} from "../../contracts/rule-catalog-query.js";
import {
  ruleCatalogEntrySchema,
  ruleActivationHistorySchema,
} from "../../contracts/rule-catalog.js";
import { hasCapability, type Actor } from "../../contracts/identity.js";
import { PersistenceError } from "../ports/persistence.js";
import type {
  RuleCatalogReadRepository,
  RuleCatalogReadTransaction,
} from "./catalog-read-ports.js";
import { exportRule } from "./export.js";
async function authorize(tx: RuleCatalogReadTransaction, actor: Actor) {
  const current = await tx.responders.get(actor.responderId);
  if (
    actor.workspaceId !== tx.workspaceId ||
    !current?.enabled ||
    current.id !== actor.responderId ||
    current.workspaceId !== tx.workspaceId ||
    current.role !== actor.role ||
    !hasCapability(current.role, "rule:read")
  )
    throw new Error("Rule read forbidden");
}
/** GET paths do not acquire live source locks or create policy history. */
export class RuleCatalogQueries {
  constructor(private readonly repository: RuleCatalogReadRepository) {}
  list(actor: Actor, raw: unknown) {
    const input = ruleCatalogListSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const rows = z
        .array(ruleCatalogEntrySchema)
        .max(input.limit + 1)
        .parse(await tx.catalogRead.list(input));
      if (
        rows.some(
          (r) =>
            r.workspaceId !== tx.workspaceId ||
            r.serviceId !== input.serviceId ||
            r.environmentId !== input.environmentId,
        )
      )
        throw new PersistenceError("scope_violation");
      const items = rows.slice(0, input.limit);
      return {
        items,
        next: rows.length > input.limit ? items.at(-1)!.id : null,
      };
    });
  }
  get(actor: Actor, raw: unknown): Promise<RuleCatalogView | undefined> {
    const input = ruleCatalogIdSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const found = await tx.catalogRead.get(input.id);
      if (!found) return undefined;
      const row = ruleCatalogViewSchema.parse(found);
      if (row.entry.workspaceId !== tx.workspaceId || row.entry.id !== input.id)
        throw new PersistenceError("scope_violation");
      return row;
    });
  }
  history(actor: Actor, raw: unknown) {
    const input = ruleCatalogHistoryQuerySchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const rows = z
        .array(ruleActivationHistorySchema)
        .max(input.limit + 1)
        .parse(await tx.catalogRead.history(input));
      if (
        rows.some(
          (r) => r.workspaceId !== tx.workspaceId || r.ruleId !== input.ruleId,
        )
      )
        throw new PersistenceError("scope_violation");
      const items = rows.slice(0, input.limit);
      return {
        items,
        next: rows.length > input.limit ? items.at(-1)!.catalogRevision : null,
      };
    });
  }
  async export(actor: Actor, raw: unknown) {
    const found = await this.get(actor, raw);
    if (!found) throw new PersistenceError("not_found");
    return exportRule(found.entry, found.version);
  }
}
