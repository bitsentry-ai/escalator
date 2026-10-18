import { z } from "zod";
import {
  hasCapability,
  opaqueIdSchema,
  type Actor,
} from "../../contracts/identity.js";
import {
  ruleCatalogEntrySchema,
  ruleReviewReceiptSchema,
  ruleActivationHistorySchema,
  type RuleCatalogEntry,
} from "../../contracts/rule-catalog.js";
import { ruleLiveRecordSchema } from "../../contracts/rule-live.js";
import { detectionRuleVersionSchema } from "../../contracts/rule-state.js";
import { PersistenceError } from "../ports/persistence.js";
import { pagingWorkId } from "../paging/work-ids.js";
import { ruleEvaluationJobId } from "./live.js";
import { ruleActivationEligibility } from "./review-eligibility.js";
import { assertCurrentRuleReview } from "./review-state.js";
import type {
  RuleCatalogRepository,
  RuleCatalogTransaction,
} from "./activation-ports.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reviewInput = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
  versionRevision: revision,
  mode: z.enum(["shadow", "active"]),
  runId: opaqueIdSchema.nullable(),
});
const activationInput = z.strictObject({
  ruleId: opaqueIdSchema,
  receiptId: opaqueIdSchema,
});
const retirementInput = z.strictObject({
  ruleId: opaqueIdSchema,
  expectedRevision: revision,
});
async function authorize(tx: RuleCatalogTransaction, actor: Actor) {
  const person = await tx.responders.get(actor.responderId);
  if (
    actor.workspaceId !== tx.workspaceId ||
    !person?.enabled ||
    person.id !== actor.responderId ||
    person.workspaceId !== tx.workspaceId ||
    person.role !== actor.role ||
    !hasCapability(person.role, "rule:approve")
  )
    throw new Error("Rule approval forbidden");
}
async function locked(tx: RuleCatalogTransaction, id: string) {
  const raw = await tx.catalog.lock(id);
  if (!raw) throw new PersistenceError("not_found");
  const row = ruleCatalogEntrySchema.parse(raw);
  if (row.id !== id || row.workspaceId !== tx.workspaceId)
    throw new PersistenceError("scope_violation");
  return row;
}
async function versionFor(
  tx: RuleCatalogTransaction,
  row: RuleCatalogEntry,
  revision: number,
) {
  const raw = await tx.catalog.version(row.id, revision);
  if (!raw) throw new PersistenceError("not_found");
  const version = detectionRuleVersionSchema.parse(raw),
    d = version.definition;
  if (
    version.id !== row.id ||
    version.revision !== revision ||
    d.workspaceId !== tx.workspaceId ||
    d.serviceId !== row.serviceId ||
    d.environmentId !== row.environmentId
  )
    throw new PersistenceError("scope_violation");
  return version;
}
async function record(
  tx: RuleCatalogTransaction,
  actor: Actor,
  before: RuleCatalogEntry,
  next: RuleCatalogEntry,
  action: "shadowed" | "activated" | "rolled_back" | "retired",
  incidentId: string | null,
  receiptId: string | null,
) {
  if (!(await tx.catalog.save(next, before.revision)))
    throw new Error("Rule changed concurrently");
  const id = pagingWorkId(
    tx.workspaceId,
    "rule-activation-history",
    next.id,
    String(next.revision),
  );
  await tx.catalog.history(
    ruleActivationHistorySchema.parse({
      id,
      workspaceId: tx.workspaceId,
      ruleId: next.id,
      catalogRevision: next.revision,
      versionRevision: next.versionRevision,
      generation: next.generation,
      action,
      actorId: actor.responderId,
      previousVersionRevision: before.versionRevision,
      previousIncidentId: incidentId,
      receiptId,
      recordedAt: next.updatedAt,
    }),
  );
  await tx.audit.append({
    id,
    workspaceId: tx.workspaceId,
    actor: { kind: "responder", responderId: actor.responderId },
    action: "rule." + action,
    subjectType: "rule",
    subjectId: next.id,
    recordedAt: next.updatedAt,
    metadata: {
      versionRevision: next.versionRevision,
      generation: next.generation,
      receiptId,
    },
  });
}
/** Human-only entry point. Model and replay ports do not expose this repository.
 * Review and activation are separate transactions; activation recomputes every
 * fingerprint under locks before replacing runtime and queueing its first tick. */
export class ReviewRuleActivation {
  constructor(
    private readonly repository: RuleCatalogRepository,
    private readonly newId: () => string,
  ) {}
  review(actor: Actor, raw: unknown) {
    const input = reviewInput.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const entry = await locked(tx, input.ruleId);
      if (entry.revision !== input.expectedRevision)
        throw new Error("Rule changed concurrently");
      const version = await versionFor(tx, entry, input.versionRevision);
      const evidence = await tx.catalog.evidence(entry, version, input.runId);
      if (evidence.measurementHash !== evidence.fingerprint.measurementHash)
        throw new Error("Rule measurement evidence mismatch");
      if (input.mode === "active") {
        if (!evidence.policyKnown || !evidence.policyEnabled)
          throw new Error("Current paging policy is unavailable");
        const eligibility = ruleActivationEligibility(version, evidence.report);
        if (!eligibility.eligible)
          throw new Error(
            "Rule requires usable historical evidence: " + eligibility.reason,
          );
      }
      const now = await tx.catalog.currentTime();
      const receipt = ruleReviewReceiptSchema.parse({
        id: this.newId(),
        workspaceId: tx.workspaceId,
        ruleId: entry.id,
        catalogRevision: entry.revision,
        versionRevision: version.revision,
        reviewedBy: actor.responderId,
        mode: input.mode,
        runId: input.runId,
        fingerprint: evidence.fingerprint,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + 900000).toISOString(),
      });
      await tx.catalog.insertReview(receipt);
      return receipt;
    });
  }
  activate(actor: Actor, raw: unknown) {
    const input = activationInput.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const entry = await locked(tx, input.ruleId),
        rawReceipt = await tx.catalog.review(input.receiptId);
      if (!rawReceipt) throw new PersistenceError("not_found");
      const receipt = ruleReviewReceiptSchema.parse(rawReceipt);
      if (receipt.id !== input.receiptId)
        throw new PersistenceError("scope_violation");
      const version = await versionFor(tx, entry, receipt.versionRevision);
      const evidence = await tx.catalog.evidence(entry, version, receipt.runId),
        now = await tx.catalog.currentTime();
      assertCurrentRuleReview(entry, receipt, actor, evidence.fingerprint, now);
      if (evidence.measurementHash !== evidence.fingerprint.measurementHash)
        throw new Error("Rule measurement evidence mismatch");
      if (
        receipt.mode === "active" &&
        (!evidence.policyKnown ||
          !evidence.policyEnabled ||
          !ruleActivationEligibility(version, evidence.report).eligible)
      )
        throw new Error("Rule is no longer eligible for activation");
      const previous = await tx.catalog.runtime(entry.id);
      if (
        previous &&
        (previous.version.id !== entry.id ||
          previous.version.definition.workspaceId !== tx.workspaceId ||
          previous.generation !== entry.generation)
      )
        throw new PersistenceError("scope_violation");
      const generation = entry.generation + 1,
        step = version.definition.stepSeconds * 1000,
        dueAt = new Date(
          Math.ceil(Date.parse(now) / step) * step,
        ).toISOString();
      const runtime = ruleLiveRecordSchema.parse({
        version,
        generation,
        revision: 1,
        mode: receipt.mode,
        title: entry.title,
        measurementHash: evidence.measurementHash,
        state: null,
        incidentId: null,
        dueAt,
        jobId: ruleEvaluationJobId(tx.workspaceId, entry.id, generation, dueAt),
      });
      await tx.catalog.retireRuntime(entry.id);
      await tx.catalog.activateRuntime(runtime);
      await tx.work.enqueue("job", {
        id: runtime.jobId,
        kind: "rules.evaluate",
        idempotencyKey: runtime.jobId,
        dueAt,
        payload: { ruleId: entry.id, generation, dueAt },
      });
      const next = ruleCatalogEntrySchema.parse({
        ...entry,
        revision: entry.revision + 1,
        versionRevision: version.revision,
        generation,
        status: receipt.mode,
        updatedAt: now,
      });
      const action =
        version.revision < entry.versionRevision
          ? "rolled_back"
          : receipt.mode === "active"
            ? "activated"
            : "shadowed";
      await record(
        tx,
        actor,
        entry,
        next,
        action,
        previous?.incidentId ?? null,
        receipt.id,
      );
      return next;
    });
  }
  retire(actor: Actor, raw: unknown) {
    const input = retirementInput.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const entry = await locked(tx, input.ruleId);
      if (entry.revision !== input.expectedRevision)
        throw new Error("Rule changed concurrently");
      if (entry.status === "retired") return entry;
      const previous = await tx.catalog.runtime(entry.id);
      if (
        previous &&
        (previous.version.id !== entry.id ||
          previous.version.definition.workspaceId !== tx.workspaceId ||
          previous.generation !== entry.generation)
      )
        throw new PersistenceError("scope_violation");
      await tx.catalog.retireRuntime(entry.id);
      const next = ruleCatalogEntrySchema.parse({
        ...entry,
        revision: entry.revision + 1,
        status: "retired",
        updatedAt: await tx.catalog.currentTime(),
      });
      await record(
        tx,
        actor,
        entry,
        next,
        "retired",
        previous?.incidentId ?? null,
        null,
      );
      return next;
    });
  }
}
