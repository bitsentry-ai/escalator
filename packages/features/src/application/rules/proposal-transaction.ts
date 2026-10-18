import {
  ruleProposalSchema,
  ruleProposalClaimSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import { opaqueIdSchema } from "../../contracts/identity.js";
import { incidentLabelSchema } from "../../contracts/rule-label.js";
import { modelProfileSchema } from "../../contracts/model-profile.js";
import { utcTimestampSchema } from "../../contracts/entities.js";
import { compareUtcTimestamps } from "../../contracts/timestamps.js";
import { PersistenceError } from "../ports/persistence.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type {
  RuleProposalStore,
  RuleProposalTransaction,
} from "./proposal-ports.js";
import type { RuleReplayCaptureTransaction } from "./replay-capture.js";
import type { RuleBacktestTransaction } from "./backtest-ports.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Host adapters share identity, revision and transaction-lifetime checks. The
 * database additionally fences leases, caps capacity and enforces tenant keys. */
export function withRuleProposals<
  T extends RuleReplayCaptureTransaction & RuleBacktestTransaction,
>(
  base: T,
  store: RuleProposalStore,
  guard: TransactionGuard,
): T & RuleProposalTransaction {
  const locked = new Map<string, RuleProposal>();
  const scope = (row: { workspaceId: string }) => {
    if (row.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  return {
    ...base,
    proposals: {
      currentTime: () =>
        guard.operation(async () =>
          utcTimestampSchema.parse(await store.currentTime()),
        ),
      lock: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.lock(id);
          if (!raw) return undefined;
          const row = ruleProposalSchema.parse(raw);
          scope(row);
          if (row.id !== id) throw new PersistenceError("scope_violation");
          locked.set(id, structuredClone(row));
          return row;
        }),
      insert: (raw) =>
        guard.operation(async () => {
          const row = ruleProposalSchema.parse(raw);
          scope(row);
          if (
            row.status !== "queued" ||
            row.revision !== 1 ||
            row.updatedAt !== row.createdAt ||
            locked.has(row.id)
          )
            throw new Error("Invalid initial proposal");
          await store.insert(row);
          locked.set(row.id, structuredClone(row));
        }),
      save: (raw, expected) =>
        guard.operation(async () => {
          const row = ruleProposalSchema.parse(raw);
          scope(row);
          const before = locked.get(row.id);
          if (
            !before ||
            before.revision !== expected ||
            row.revision !== expected + 1 ||
            compareUtcTimestamps(row.updatedAt, before.updatedAt) < 0
          )
            throw new Error("Proposal revision conflict");
          const mutable = new Set([
            "revision",
            "status",
            "generation",
            "failure",
            "fullRunId",
            "heldOutRunId",
            "updatedAt",
          ]);
          for (const key of Object.keys(before) as (keyof RuleProposal)[])
            if (!mutable.has(key) && !same(before[key], row[key]))
              throw new Error("Immutable proposal field changed");
          const allowed: Record<
            RuleProposal["status"],
            readonly RuleProposal["status"][]
          > = {
            queued: ["cancelled", "failed"],
            generating: ["evaluating", "failed", "cancelled"],
            evaluating: ["evaluating", "ready", "failed", "cancelled"],
            ready: [],
            failed: [],
            cancelled: [],
          };
          if (
            !allowed[before.status].includes(row.status) ||
            (before.generation && !same(before.generation, row.generation)) ||
            (before.fullRunId && before.fullRunId !== row.fullRunId) ||
            (before.heldOutRunId && before.heldOutRunId !== row.heldOutRunId)
          )
            throw new Error("Invalid proposal transition");
          if (row.status === "ready")
            throw new Error("Report attachment is required before readiness");
          const accepted = await store.save(row, expected);
          if (accepted) locked.set(row.id, structuredClone(row));
          return accepted;
        }),
      label: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.label(id);
          if (!raw) return undefined;
          const row = incidentLabelSchema.parse(raw);
          scope(row);
          if (row.id !== id) throw new PersistenceError("scope_violation");
          return row;
        }),
      profile: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.profile(id);
          if (!raw) return undefined;
          const row = modelProfileSchema.parse(raw);
          scope(row.scope);
          if (row.id !== id) throw new PersistenceError("scope_violation");
          return row;
        }),
      lockClaim: (raw) =>
        guard.operation(async () => {
          const hint = ruleProposalClaimSchema.parse(raw);
          scope(hint);
          if (locked.get(hint.proposalId)?.status !== "generating")
            return undefined;
          const actual = await store.lockClaim(hint);
          if (!actual) return undefined;
          const claim = ruleProposalClaimSchema.parse(actual);
          scope(claim);
          if (
            claim.proposalId !== hint.proposalId ||
            claim.runtimeId !== hint.runtimeId ||
            claim.token !== hint.token
          )
            throw new PersistenceError("scope_violation");
          return claim;
        }),
      scheduleEvaluation: (raw) =>
        guard.operation(async () => {
          const row = ruleProposalSchema.parse(raw);
          scope(row);
          if (row.status !== "evaluating" || !same(row, locked.get(row.id)))
            throw new Error("Evaluation requires a saved candidate");
          await store.scheduleEvaluation(row);
        }),
      releaseClaim: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const row = locked.get(id);
          if (!row || ["queued", "generating"].includes(row.status))
            throw new Error("Generation is unfinished");
          await store.releaseClaim(id);
        }),
    },
  };
}
