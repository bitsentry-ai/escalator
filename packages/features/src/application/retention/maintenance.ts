import { createHash } from "node:crypto";
import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  workspaceIdSchema,
  replayRetentionSettingsSchema,
  type WorkspaceId,
  type ReplayRetentionSettings,
} from "../../contracts/index.js";
import type { TransactionGuard } from "../ports/transaction-guard.js";
import type { WorkLease } from "../jobs/ports.js";
import type { WorkHandlerResult } from "../jobs/runner.js";
import {
  pruneReplayInTransaction,
  type ReplayPruneTransaction,
} from "./pruning.js";
import { defaultRetentionCeilings } from "./policy-management.js";
export const retentionMaintenanceKind = "retention.sweep";
const cursorSchema = z.strictObject({
  kind: z.enum(["signal", "probe", "metric"]),
  id: opaqueIdSchema,
  observedAt: utcTimestampSchema,
});
export const retentionMaintenanceStateSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    jobId: opaqueIdSchema,
    dueAt: utcTimestampSchema,
    sourceId: opaqueIdSchema.nullable(),
    after: cursorSchema.nullable(),
    sweepStartedAt: utcTimestampSchema.nullable(),
    completedAt: utcTimestampSchema.nullable(),
  })
  .refine((value) =>
    value.sourceId === null
      ? value.after === null
      : value.sweepStartedAt !== null,
  );
export type RetentionMaintenanceState = z.infer<
  typeof retentionMaintenanceStateSchema
>;
export const retentionMaintenancePayloadSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sourceId: opaqueIdSchema.nullable(),
});
export interface RetentionMaintenanceWork {
  kind: string;
  state: "pending" | "running" | "completed" | "cancelled" | "failed";
  payload: unknown;
}
export interface RetentionMaintenanceTransaction extends ReplayPruneTransaction {
  maintenance: {
    /** Serialize even missing state. Source lock, then singleton lock, then work/accounting. */
    lock(): Promise<RetentionMaintenanceState | undefined>;
    /** Locks only the current schedule job, after the singleton lock. */
    lockWork(id: string): Promise<RetentionMaintenanceWork | undefined>;
    put(
      value: RetentionMaintenanceState,
      expectedRevision: number | null,
    ): Promise<boolean>;
    /** Once per locked schedule, before receipt/accounting locks. */
    retireWork(): Promise<number>;
    /** Scoped indexed ID seek only; never takes another source row lock. */
    nextSource(after: string | null): Promise<string | undefined>;
  };
}
export interface RetentionMaintenanceRepository {
  /** Non-locking hint only; run() revalidates under locks. */
  read(scope: WorkspaceId): Promise<RetentionMaintenanceState | undefined>;
  transaction<T>(
    scope: WorkspaceId,
    sourceHint: string | null,
    run: (tx: RetentionMaintenanceTransaction) => Promise<T>,
  ): Promise<T>;
}
export type RetentionMaintenanceStore = Omit<
  RetentionMaintenanceTransaction["maintenance"],
  "retireWork"
> & {
  retireWork(
    state: RetentionMaintenanceState,
    databaseNow: string,
  ): Promise<number>;
};
/** Validation and poisoning are shared; hosts supply scoped physical locks and CAS. */
export function retentionMaintenanceTransaction(
  base: ReplayPruneTransaction,
  store: RetentionMaintenanceStore,
  guard: TransactionGuard,
): RetentionMaintenanceTransaction {
  let lockStarted = false,
    locked = false,
    written = false;
  let cleanupStarted = false,
    pruningStarted = false;
  let lockedState: RetentionMaintenanceState | undefined;
  let revision: number | null = null,
    jobId: string | null = null;
  return {
    ...base,
    retentionPrune: {
      ...base.retentionPrune,
      snapshot(after) {
        pruningStarted = true;
        return base.retentionPrune.snapshot(after);
      },
    },
    maintenance: {
      lock: () =>
        guard.operation(async () => {
          if (lockStarted) throw new Error("Retention schedule already locked");
          lockStarted = true;
          const raw = await store.lock();
          const state = raw ? checkedState(base.workspaceId, raw) : undefined;
          lockedState = structuredClone(state);
          revision = state?.revision ?? null;
          jobId = state?.jobId ?? null;
          locked = true;
          return structuredClone(state);
        }),
      lockWork: (id) =>
        guard.operation(async () => {
          if (!locked || id !== jobId)
            throw new Error("Invalid retention work lock");
          const work = await store.lockWork(id);
          if (
            work &&
            ![
              "pending",
              "running",
              "completed",
              "cancelled",
              "failed",
            ].includes(work.state)
          )
            throw new Error("Invalid retention work state");
          return structuredClone(work);
        }),
      put: (raw, expected) =>
        guard.operation(async () => {
          if (!locked || written || expected !== revision)
            throw new Error("Invalid retention schedule write");
          const state = checkedState(base.workspaceId, raw);
          if (state.revision !== (revision ?? 0) + 1)
            throw new Error("Invalid retention schedule revision");
          written = true;
          if (!(await store.put(structuredClone(state), expected)))
            throw new Error("Retention schedule conflict");
          return true;
        }),
      retireWork: () =>
        guard.operation(async () => {
          if (
            !locked ||
            !lockedState ||
            cleanupStarted ||
            pruningStarted ||
            written
          )
            throw new Error("Invalid retention work cleanup order");
          cleanupStarted = true;
          const count = await store.retireWork(
            structuredClone(lockedState),
            base.now,
          );
          if (!Number.isSafeInteger(count) || count < 0 || count > 100)
            throw new Error("Invalid retired work count");
          return count;
        }),
      nextSource: (after) =>
        guard.operation(async () => {
          if (!locked) throw new Error("Retention schedule is not locked");
          if (after !== null) opaqueIdSchema.parse(after);
          const next = await store.nextSource(after);
          if (next !== undefined) {
            opaqueIdSchema.parse(next);
            if (after !== null && next <= after)
              throw new Error("Invalid retention source traversal");
          }
          return next;
        }),
    },
  };
}
export function retentionMaintenanceId(scope: WorkspaceId, revision: number) {
  workspaceIdSchema.parse(scope);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Invalid retention revision");
  return (
    "retention.sweep:" +
    createHash("sha256")
      .update(JSON.stringify([scope, revision]))
      .digest("hex")
  );
}
const payload = (state: RetentionMaintenanceState) => ({
  version: 1,
  revision: state.revision,
  sourceId: state.sourceId,
});
function checkedState(scope: WorkspaceId, value: RetentionMaintenanceState) {
  const state = retentionMaintenanceStateSchema.parse(value);
  if (
    state.workspaceId !== scope ||
    state.jobId !== retentionMaintenanceId(scope, state.revision)
  )
    throw new Error("Invalid retention schedule identity");
  return state;
}
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Retention operation cancelled");
}
async function persist(
  tx: RetentionMaintenanceTransaction,
  next: RetentionMaintenanceState,
  previous: number | null,
) {
  checkedState(tx.workspaceId, next);
  // Under the singleton lock a new revision cannot already have an intent. A duplicate
  // means corruption/conflicting state; do not silently adopt its unknown payload.
  const inserted = await tx.work.enqueue("job", {
    id: next.jobId,
    idempotencyKey: next.jobId,
    kind: retentionMaintenanceKind,
    dueAt: next.dueAt,
    payload: payload(next),
  });
  if (inserted !== "inserted" || !(await tx.maintenance.put(next, previous)))
    throw new Error("Retention successor conflict");
}
async function nextSource(
  tx: RetentionMaintenanceTransaction,
  after: string | null,
) {
  const next = await tx.maintenance.nextSource(after);
  if (next === undefined) return null;
  opaqueIdSchema.parse(next);
  if (after !== null && next <= after)
    throw new Error("Invalid retention source traversal");
  return next;
}
export async function initializeRetentionMaintenance(
  repository: RetentionMaintenanceRepository,
  scope: WorkspaceId,
  repairDelayMs = 3600000,
) {
  if (
    !Number.isSafeInteger(repairDelayMs) ||
    repairDelayMs < 60000 ||
    repairDelayMs > 86400000
  )
    throw new Error("Invalid retention repair delay");
  await repository.transaction(scope, null, async (tx) => {
    const raw = await tx.maintenance.lock();
    if (raw) {
      const state = checkedState(scope, raw);
      const work = await tx.maintenance.lockWork(state.jobId);
      if (work) {
        const input = retentionMaintenancePayloadSchema.parse(work.payload);
        if (
          work.kind !== retentionMaintenanceKind ||
          input.revision !== state.revision ||
          input.sourceId !== state.sourceId
        )
          throw new Error("Invalid retention scheduled work");
        if (work.state === "pending" || work.state === "running") return;
      }
      const revision = state.revision + 1;
      const next = checkedState(scope, {
        ...state,
        revision,
        jobId: retentionMaintenanceId(scope, revision),
        dueAt: new Date(Date.parse(tx.now) + repairDelayMs).toISOString(),
      });
      await persist(tx, next, state.revision);
      await tx.audit.append({
        id: `retention-repair:${next.jobId}`,
        workspaceId: scope,
        actor: { kind: "system", component: "retention" },
        action: "retention.maintenance.repaired",
        subjectType: "retention_schedule",
        subjectId: scope,
        recordedAt: tx.now,
        metadata: {
          previousRevision: state.revision,
          previousState: work?.state ?? "missing",
        },
      });
      return;
    }
    await persist(
      tx,
      {
        workspaceId: scope,
        revision: 1,
        jobId: retentionMaintenanceId(scope, 1),
        dueAt: tx.now,
        sourceId: null,
        after: null,
        sweepStartedAt: null,
        completedAt: null,
      },
      null,
    );
  });
}

export class RetentionMaintenanceJobs {
  private readonly limits: ReplayRetentionSettings;
  constructor(
    private readonly repository: RetentionMaintenanceRepository,
    private readonly intervalMs = 3600000,
    private readonly batchDelayMs = 1000,
    limits: ReplayRetentionSettings = { ...defaultRetentionCeilings },
  ) {
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 60000 ||
      intervalMs > 86400000 ||
      !Number.isSafeInteger(batchDelayMs) ||
      batchDelayMs < 100 ||
      batchDelayMs > 60000
    )
      throw new Error("Invalid retention cadence");
    this.limits = Object.freeze(replayRetentionSettingsSchema.parse(limits));
  }
  async run(lease: WorkLease, signal: AbortSignal): Promise<WorkHandlerResult> {
    if (signal.aborted) return { state: "stale" };
    const hint = await this.repository.read(lease.workspaceId);
    if (!hint) throw new Error("Retention schedule missing");
    const selected = checkedState(lease.workspaceId, hint);
    return this.repository.transaction<WorkHandlerResult>(
      lease.workspaceId,
      selected.sourceId,
      async (tx) => {
        checkAbort(signal);
        const current = await tx.maintenance.lock();
        if (!current) throw new Error("Retention schedule missing");
        const state = checkedState(tx.workspaceId, current);
        const claim = await tx.work.lockClaim(lease);
        if (!claim) return { state: "stale" };
        const input = retentionMaintenancePayloadSchema.parse(claim.payload);
        if (
          claim.queue !== "job" ||
          claim.kind !== retentionMaintenanceKind ||
          claim.id !== retentionMaintenanceId(tx.workspaceId, input.revision)
        )
          throw new Error("Invalid retention claim");
        if (state.jobId !== claim.id) return { state: "completed" };
        if (
          state.revision !== selected.revision ||
          state.sourceId !== selected.sourceId
        )
          throw new Error("Retention source hint changed");
        if (
          input.revision !== state.revision ||
          input.sourceId !== state.sourceId
        )
          throw new Error("Retention payload mismatch");
        const retiredWork = await tx.maintenance.retireWork();
        if (retiredWork > 0)
          await tx.audit.append({
            id: `retention-work-audit:${state.jobId}`,
            workspaceId: tx.workspaceId,
            actor: { kind: "system", component: "retention" },
            action: "retention.jobs.pruned",
            subjectType: "workspace",
            subjectId: tx.workspaceId,
            recordedAt: tx.now,
            metadata: { deletedRows: retiredWork },
          });
        let sourceId: string | null,
          after: RetentionMaintenanceState["after"] = null;
        let sweepStartedAt = state.sweepStartedAt;
        if (state.sourceId === null) {
          sourceId = await nextSource(tx, null);
          sweepStartedAt = tx.now;
        } else {
          const result = await pruneReplayInTransaction(
            tx,
            state.sourceId,
            state.after,
            `retention-audit:${state.jobId}`,
            this.limits,
          );
          if (!result.complete) {
            if (
              !result.deletedRows &&
              JSON.stringify(result.next) === JSON.stringify(state.after)
            )
              throw new Error("Retention traversal did not advance");
            sourceId = state.sourceId;
            after = result.next;
          } else sourceId = await nextSource(tx, state.sourceId);
        }
        checkAbort(signal);
        const revision = state.revision + 1;
        const next = checkedState(tx.workspaceId, {
          ...state,
          revision,
          jobId: retentionMaintenanceId(tx.workspaceId, revision),
          sourceId,
          after,
          sweepStartedAt,
          completedAt: sourceId === null ? tx.now : state.completedAt,
          dueAt: new Date(
            Date.parse(tx.now) +
              (sourceId === null ? this.intervalMs : this.batchDelayMs),
          ).toISOString(),
        });
        await persist(tx, next, state.revision);
        checkAbort(signal);
        return { state: "completed" };
      },
    );
  }
}
