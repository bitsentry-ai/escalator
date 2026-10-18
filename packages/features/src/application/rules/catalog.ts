import { z } from "zod";
import {
  hasCapability,
  opaqueIdSchema,
  type Actor,
} from "../../contracts/identity.js";
import { detectionRuleSchema } from "../../contracts/rules.js";
import { detectionRuleVersionSchema } from "../../contracts/rule-state.js";
import {
  ruleCatalogEntrySchema,
  ruleActivationHistorySchema,
  ruleTitleSchema,
} from "../../contracts/rule-catalog.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import type {
  RuleCatalogRepository,
  RuleCatalogTransaction,
} from "./activation-ports.js";
const createInput = z.strictObject({
  title: ruleTitleSchema,
  definition: detectionRuleSchema,
});
const editInput = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: z.number().int().positive(),
  definition: detectionRuleSchema,
});
async function authorize(tx: RuleCatalogTransaction, actor: Actor) {
  const responder = await tx.responders.get(actor.responderId);
  if (
    actor.workspaceId !== tx.workspaceId ||
    !responder?.enabled ||
    responder.workspaceId !== tx.workspaceId ||
    responder.id !== actor.responderId ||
    responder.role !== actor.role ||
    !hasCapability(responder.role, "rule:propose")
  )
    throw new Error("Rule draft forbidden");
}
export class RuleDrafts {
  constructor(
    private readonly repository: RuleCatalogRepository,
    private readonly newId: () => string,
  ) {}
  create(actor: Actor, raw: unknown) {
    const input = createInput.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const definition = input.definition;
      if (definition.workspaceId !== tx.workspaceId)
        throw new PersistenceError("scope_violation");
      const version = detectionRuleVersionSchema.parse({
        id: this.newId(),
        revision: 1,
        definition,
      });
      await tx.catalog.lockDefinition(version);
      const now = await tx.catalog.currentTime();
      const entry = ruleCatalogEntrySchema.parse({
        id: version.id,
        workspaceId: tx.workspaceId,
        serviceId: definition.serviceId,
        environmentId: definition.environmentId,
        title: input.title,
        revision: 1,
        versionRevision: 1,
        generation: 0,
        status: "draft",
        originProposalId: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.catalog.insert(entry, version);
      const id = pagingWorkId(
        tx.workspaceId,
        "rule-activation-history",
        entry.id,
        "1",
      );
      await tx.catalog.history(
        ruleActivationHistorySchema.parse({
          id,
          workspaceId: tx.workspaceId,
          ruleId: entry.id,
          catalogRevision: 1,
          versionRevision: 1,
          generation: 0,
          action: "drafted",
          actorId: actor.responderId,
          previousVersionRevision: null,
          previousIncidentId: null,
          receiptId: null,
          recordedAt: now,
        }),
      );
      await tx.audit.append({
        id,
        workspaceId: tx.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "rule.drafted",
        subjectType: "rule",
        subjectId: entry.id,
        recordedAt: now,
        metadata: { versionRevision: 1 },
      });
      return entry;
    });
  }
  edit(actor: Actor, raw: unknown) {
    const input = editInput.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const loaded = await tx.catalog.lock(input.ruleId);
      if (!loaded) throw new PersistenceError("not_found");
      const entry = ruleCatalogEntrySchema.parse(loaded),
        d = input.definition;
      if (
        entry.id !== input.ruleId ||
        entry.workspaceId !== tx.workspaceId ||
        d.workspaceId !== tx.workspaceId ||
        d.serviceId !== entry.serviceId ||
        d.environmentId !== entry.environmentId
      )
        throw new PersistenceError("scope_violation");
      if (
        entry.revision !== input.expectedRevision ||
        !["draft", "retired"].includes(entry.status)
      )
        throw new Error(
          "Retire the current rule before changing its definition",
        );
      const oldRaw = await tx.catalog.version(entry.id, entry.versionRevision);
      if (!oldRaw) throw new PersistenceError("not_found");
      const old = detectionRuleVersionSchema.parse(oldRaw);
      if (
        old.id !== entry.id ||
        old.revision !== entry.versionRevision ||
        old.definition.workspaceId !== tx.workspaceId
      )
        throw new PersistenceError("scope_violation");
      if (
        old.definition.selector.kind !== d.selector.kind ||
        old.definition.selector.streamId !== d.selector.streamId
      )
        throw new Error("A different source requires a new rule draft");
      const version = detectionRuleVersionSchema.parse({
        id: entry.id,
        revision: (await tx.catalog.latestVersionRevision(entry.id)) + 1,
        definition: d,
      });
      await tx.catalog.insertVersion(version);
      const now = await tx.catalog.currentTime();
      const next = ruleCatalogEntrySchema.parse({
        ...entry,
        revision: entry.revision + 1,
        versionRevision: version.revision,
        status: "draft",
        updatedAt: now,
      });
      if (!(await tx.catalog.save(next, entry.revision)))
        throw new Error("Rule changed concurrently");
      const id = pagingWorkId(
        tx.workspaceId,
        "rule-activation-history",
        entry.id,
        String(next.revision),
      );
      await tx.catalog.history(
        ruleActivationHistorySchema.parse({
          id,
          workspaceId: tx.workspaceId,
          ruleId: entry.id,
          catalogRevision: next.revision,
          versionRevision: version.revision,
          generation: entry.generation,
          action: "revised",
          actorId: actor.responderId,
          previousVersionRevision: entry.versionRevision,
          previousIncidentId: null,
          receiptId: null,
          recordedAt: now,
        }),
      );
      await tx.audit.append({
        id,
        workspaceId: tx.workspaceId,
        actor: { kind: "responder", responderId: actor.responderId },
        action: "rule.revised",
        subjectType: "rule",
        subjectId: entry.id,
        recordedAt: now,
        metadata: { versionRevision: version.revision },
      });
      return next;
    });
  }
}
