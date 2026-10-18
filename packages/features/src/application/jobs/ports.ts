import type { WorkspaceId } from "../../contracts/index.js";
import type { JsonValue } from "../ports/audit.js";

export type WorkQueue = "job" | "outbox";
export interface WorkIntent {
  id: string;
  kind: string;
  idempotencyKey: string;
  payload: { [key: string]: JsonValue };
  dueAt: string;
  priority?: number;
}
/** These operations join the host's surrounding domain transaction. */
export interface WorkWriter {
  enqueue(
    queue: WorkQueue,
    intent: WorkIntent,
  ): Promise<"inserted" | "duplicate">;
  cancel(queue: WorkQueue, ids: readonly string[]): Promise<number>;
}
export interface WorkLease {
  workspaceId: WorkspaceId;
  queue: WorkQueue;
  id: string;
  kind: string;
  payload: { [key: string]: JsonValue };
  token: string;
  attempt: number;
  dueAt: string;
  leaseExpiresAt: string;
}
export type WorkResult =
  | {
      state: "completed";
      outcome?: "accepted" | "rejected" | "unknown";
      receipt?: string;
    }
  | { state: "retry"; delayMs: number; outcome?: "unknown" | "rejected" }
  | { state: "failed"; outcome?: "unknown" | "rejected" };
export interface DurableWorkStore {
  /** Commit the claim before returning; durations/deadlines use database time. */
  claim(input: {
    workspaceId: WorkspaceId;
    queue: WorkQueue;
    token: string;
    leaseMs: number;
    kinds: readonly string[];
  }): Promise<WorkLease | undefined>;
  /** Matching token AND unexpired lease are required, even without a newer claim. */
  settle(lease: WorkLease, result: WorkResult): Promise<boolean>;
}
