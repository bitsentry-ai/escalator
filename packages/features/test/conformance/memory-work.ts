import type { WorkspaceId } from "../../src/contracts/index.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import {
  validateWorkIntent,
  validateWorkFence,
  validateWorkClaim,
  validateWorkResult,
  validateWorkCancellation,
} from "../../src/application/jobs/validation.js";
import type {
  WorkIntent,
  WorkWriter,
  WorkQueue,
  WorkLease,
  WorkResult,
  DurableWorkStore,
} from "../../src/application/jobs/ports.js";
export interface MemoryWork {
  workspaceId: WorkspaceId;
  queue: WorkQueue;
  intent: WorkIntent;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  token?: string;
  leaseExpiresAt?: string;
  outcome?: "accepted" | "rejected" | "unknown";
}
export function memoryWorkWriter(
  rows: MemoryWork[],
  workspaceId: WorkspaceId,
  exists: () => void,
  now: () => Date,
): WorkWriter {
  return {
    async lockClaim(lease) {
      validateWorkFence(lease);
      if (lease.workspaceId !== workspaceId)
        throw new PersistenceError("scope_violation");
      const row = rows.find(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.queue === lease.queue &&
          entry.intent.id === lease.id,
      );
      if (
        !row ||
        row.state !== "running" ||
        row.token !== lease.token ||
        Date.parse(row.leaseExpiresAt!) <= now().getTime()
      )
        return undefined;
      return structuredClone({
        workspaceId,
        queue: row.queue,
        id: row.intent.id,
        kind: row.intent.kind,
        payload: row.intent.payload,
        token: lease.token,
        attempt: row.attempt,
        dueAt: row.intent.dueAt,
        leaseExpiresAt: row.leaseExpiresAt!,
      });
    },
    async enqueue(queue, input) {
      const intent = validateWorkIntent(queue, input);
      exists();
      const scoped = rows.filter(
        (row) => row.workspaceId === workspaceId && row.queue === queue,
      );
      if (
        scoped.some(
          (row) =>
            row.intent.kind === intent.kind &&
            row.intent.idempotencyKey === intent.idempotencyKey,
        )
      )
        return "duplicate";
      if (scoped.some((row) => row.intent.id === intent.id))
        throw new PersistenceError("already_exists");
      rows.push({
        workspaceId,
        queue,
        intent: structuredClone(intent),
        state: "pending",
        attempt: 0,
      });
      return "inserted";
    },
    async cancel(queue, ids) {
      validateWorkCancellation(queue, ids);
      const matches = rows.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.queue === queue &&
          ids.includes(row.intent.id) &&
          ["pending", "running"].includes(row.state),
      );
      for (const row of matches) {
        row.state = "cancelled";
        delete row.token;
        delete row.leaseExpiresAt;
      }
      return matches.length;
    },
  };
}
export function memoryClaim(
  rows: MemoryWork[],
  input: Parameters<DurableWorkStore["claim"]>[0],
  now: Date,
): WorkLease | undefined {
  validateWorkClaim(input);
  const candidates = rows.filter(
    (row) =>
      row.workspaceId === input.workspaceId &&
      row.queue === input.queue &&
      input.kinds.includes(row.intent.kind) &&
      ((row.state === "pending" &&
        Date.parse(row.intent.dueAt) <= now.getTime()) ||
        (row.state === "running" &&
          Date.parse(row.leaseExpiresAt!) <= now.getTime())),
  );
  candidates.sort(
    (a, b) =>
      (input.queue === "job"
        ? (b.intent.priority ?? 0) - (a.intent.priority ?? 0)
        : 0) ||
      Date.parse(a.intent.dueAt) - Date.parse(b.intent.dueAt) ||
      (a.intent.id < b.intent.id ? -1 : a.intent.id > b.intent.id ? 1 : 0),
  );
  const row = candidates[0];
  if (!row) return undefined;
  if (row.queue === "outbox" && row.state === "running")
    row.outcome = "unknown";
  row.state = "running";
  row.token = input.token;
  row.attempt += 1;
  row.leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  return {
    workspaceId: input.workspaceId,
    queue: input.queue,
    id: row.intent.id,
    kind: row.intent.kind,
    payload: structuredClone(row.intent.payload),
    token: input.token,
    attempt: row.attempt,
    dueAt: row.intent.dueAt,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}
export function memorySettle(
  rows: MemoryWork[],
  lease: WorkLease,
  result: WorkResult,
  now: Date,
): boolean {
  validateWorkResult(lease, result);
  const row = rows.find(
    (row) =>
      row.workspaceId === lease.workspaceId &&
      row.queue === lease.queue &&
      row.intent.id === lease.id,
  );
  if (
    !row ||
    row.state !== "running" ||
    row.token !== lease.token ||
    Date.parse(row.leaseExpiresAt!) <= now.getTime()
  )
    return false;
  row.state =
    result.state === "retry" || result.state === "wait"
      ? "pending"
      : result.state;
  if (result.state === "retry" || result.state === "wait")
    row.intent.dueAt = new Date(now.getTime() + result.delayMs).toISOString();
  if (result.state === "wait") row.attempt = 0;
  row.outcome = result.outcome;
  delete row.token;
  delete row.leaseExpiresAt;
  return true;
}
