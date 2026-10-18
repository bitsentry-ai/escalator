import { ruleEvaluationJobId } from "./live.js";
import {
  opaqueIdSchema,
  ruleLiveRecordSchema,
  ruleHistoryQuerySchema,
  ruleHistorySnapshotSchema,
  ruleDecisionPolicySchema,
  ruleEvaluationStateSchema,
  type RuleLiveRecord,
} from "../../contracts/index.js";
import type { DetectionTransaction } from "../detection/ports.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import { PersistenceError } from "../ports/persistence.js";
import type { RuleLiveTransaction } from "./live-ports.js";
/** Host primitives must share the physical transaction and lock scope/source
 * before the runtime row. This decorator enforces scope and runtime-only CAS:
 * an evaluation cannot activate, retire or rewrite an immutable rule revision.
 */
export type RuleLiveRecordStore = RuleLiveTransaction["rules"];
export function withLiveRules<T extends DetectionTransaction>(
  base: T,
  store: RuleLiveRecordStore,
  guard: TransactionGuard,
): T & RuleLiveTransaction {
  const locked = new Map<string, RuleLiveRecord>();
  const scope = (row: RuleLiveRecord) => {
    if (row.version.definition.workspaceId !== base.workspaceId)
      throw new PersistenceError("scope_violation");
  };
  const sameBinding = (a: RuleLiveRecord, b: RuleLiveRecord) =>
    a.generation === b.generation &&
    a.mode === b.mode &&
    a.title === b.title &&
    a.measurementHash === b.measurementHash &&
    JSON.stringify(a.version) === JSON.stringify(b.version);
  return {
    ...base,
    rules: {
      lock: (id) =>
        guard.operation(async () => {
          opaqueIdSchema.parse(id);
          const raw = await store.lock(id);
          if (!raw) return undefined;
          const row = ruleLiveRecordSchema.parse(raw);
          scope(row);
          if (row.version.id !== id)
            throw new PersistenceError("scope_violation");
          locked.set(id, structuredClone(row));
          return row;
        }),
      history: (raw) =>
        guard.operation(async () => {
          const query = ruleHistoryQuerySchema.parse(raw);
          const row = ruleHistorySnapshotSchema.parse(
            await store.history(query),
          );
          if (
            row.workspaceId !== base.workspaceId ||
            row.serviceId !== query.serviceId ||
            row.environmentId !== query.environmentId ||
            row.streamId !== query.streamId ||
            row.kind !== query.kind ||
            row.startAt !== query.startAt ||
            row.endAt !== query.endAt ||
            row.visibleAt !== query.visibleAt
          )
            throw new PersistenceError("scope_violation");
          return row;
        }),
      policy: (raw, decisionAt) =>
        guard.operation(async () => {
          const row = ruleLiveRecordSchema.parse(raw);
          scope(row);
          const original = locked.get(row.version.id);
          if (
            !original ||
            original.revision !== row.revision ||
            !sameBinding(original, row)
          )
            throw new Error("Rule runtime revision conflict");
          return ruleDecisionPolicySchema.parse(
            await store.policy(row, decisionAt),
          );
        }),
      save: (raw, expectedRevision) =>
        guard.operation(async () => {
          const row = ruleLiveRecordSchema.parse(raw);
          scope(row);
          const previous = locked.get(row.version.id);
          if (
            !previous ||
            previous.revision !== expectedRevision ||
            row.revision !== expectedRevision + 1 ||
            !sameBinding(previous, row) ||
            Date.parse(row.dueAt) <= Date.parse(previous.dueAt) ||
            row.state === null ||
            Date.parse(row.state.lastDecisionAt) +
              row.version.definition.stepSeconds * 1000 !==
              Date.parse(row.dueAt) ||
            row.jobId !==
              ruleEvaluationJobId(
                base.workspaceId,
                row.version.id,
                row.generation,
                row.dueAt,
              )
          )
            throw new Error("Rule runtime revision conflict");
          const accepted = await store.save(row, expectedRevision);
          if (accepted) locked.set(row.version.id, structuredClone(row));
          return accepted;
        }),
      decision: (raw, transition) =>
        guard.operation(async () => {
          const row = ruleLiveRecordSchema.parse(raw);
          scope(row);
          const previous = locked.get(row.version.id);
          const state = ruleEvaluationStateSchema.parse(transition.state);
          if (
            !previous ||
            previous.revision !== row.revision ||
            !sameBinding(previous, row) ||
            state.workspaceId !== base.workspaceId ||
            state.serviceId !== row.version.definition.serviceId ||
            state.environmentId !== row.version.definition.environmentId ||
            state.ruleId !== row.version.id ||
            state.revision !== row.version.revision ||
            Date.parse(state.lastDecisionAt) < Date.parse(row.dueAt)
          )
            throw new PersistenceError("scope_violation");
          await store.decision(row, { ...transition, state });
        }),
    },
  };
}
