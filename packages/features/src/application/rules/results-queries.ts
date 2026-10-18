import {
  ruleReportDetailInputSchema,
  ruleReportDetailSchema,
} from "../../contracts/rule-report-detail.js";
import { z } from "zod";
import {
  ruleResultsListSchema,
  ruleResultIdSchema,
  ruleReplayResultSchema,
  ruleProposalViewSchema,
} from "../../contracts/rule-results.js";
import { hasCapability, type Actor } from "../../contracts/identity.js";
import { PersistenceError } from "../ports/persistence.js";
import type {
  RuleResultsRepository,
  RuleResultsTransaction,
} from "./results-ports.js";
async function authorize(tx: RuleResultsTransaction, actor: Actor) {
  const r = await tx.responders.get(actor.responderId);
  if (
    tx.workspaceId !== actor.workspaceId ||
    !r?.enabled ||
    r.id !== actor.responderId ||
    r.workspaceId !== tx.workspaceId ||
    r.role !== actor.role ||
    !hasCapability(r.role, "rule:read")
  )
    throw new Error("Rule results read forbidden");
}
export class RuleResultsQueries {
  constructor(private readonly repository: RuleResultsRepository) {}
  detail(actor: Actor, raw: unknown) {
    const input = ruleReportDetailInputSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const found = await tx.ruleResults.replay(input.runId);
      if (!found) return undefined;
      const replay = ruleReplayResultSchema.parse(found);
      if (replay.id !== input.runId || replay.workspaceId !== tx.workspaceId)
        throw new PersistenceError("scope_violation");
      if (!replay.report) return undefined;
      const detail = await tx.ruleResults.detail(input);
      if (!detail) return undefined;
      const row = ruleReportDetailSchema.parse(detail);
      if (
        row.workspaceId !== tx.workspaceId ||
        row.runId !== input.runId ||
        row.section !== input.section ||
        row.items.length > input.limit ||
        (row.next !== null && row.next !== input.offset + row.items.length) ||
        (row.section === "comparison" &&
          row.items.some(
            (item) =>
              item.observation.version.definition.workspaceId !==
                tx.workspaceId ||
              item.observation.version.definition.serviceId !==
                replay.version.definition.serviceId ||
              item.observation.version.definition.environmentId !==
                replay.version.definition.environmentId,
          ))
      )
        throw new PersistenceError("scope_violation");
      return row;
    });
  }
  replays(actor: Actor, raw: unknown) {
    const input = ruleResultsListSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const rows = z
        .array(ruleReplayResultSchema)
        .max(input.limit + 1)
        .parse(await tx.ruleResults.replays(input));
      if (
        rows.some(
          (r) =>
            r.workspaceId !== tx.workspaceId ||
            r.version.definition.serviceId !== input.serviceId ||
            r.version.definition.environmentId !== input.environmentId ||
            (input.ruleId && r.version.id !== input.ruleId),
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
  replay(actor: Actor, raw: unknown) {
    const input = ruleResultIdSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const found = await tx.ruleResults.replay(input.id);
      if (!found) return undefined;
      const row = ruleReplayResultSchema.parse(found);
      if (row.id !== input.id || row.workspaceId !== tx.workspaceId)
        throw new PersistenceError("scope_violation");
      return row;
    });
  }
  proposals(actor: Actor, raw: unknown) {
    const input = ruleResultsListSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const rows = z
        .array(ruleProposalViewSchema)
        .max(input.limit + 1)
        .parse(await tx.ruleResults.proposals(input));
      if (
        rows.some(
          (r) =>
            r.workspaceId !== tx.workspaceId ||
            r.serviceId !== input.serviceId ||
            r.environmentId !== input.environmentId ||
            (input.ruleId && r.candidateId !== input.ruleId),
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
  proposal(actor: Actor, raw: unknown) {
    const input = ruleResultIdSchema.parse(raw);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      await authorize(tx, actor);
      const found = await tx.ruleResults.proposal(input.id);
      if (!found) return undefined;
      const row = ruleProposalViewSchema.parse(found);
      if (row.id !== input.id || row.workspaceId !== tx.workspaceId)
        throw new PersistenceError("scope_violation");
      return row;
    });
  }
}
