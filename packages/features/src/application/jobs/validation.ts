import { z } from "zod";
import {
  opaqueIdSchema,
  utcTimestampSchema,
  workspaceIdSchema,
} from "../../contracts/index.js";
import type {
  DurableWorkStore,
  WorkIntent,
  WorkLease,
  WorkQueue,
  WorkResult,
} from "./ports.js";
const queueSchema = z.enum(["job", "outbox"]);
const kind = z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/);
const intentSchema = z
  .object({
    id: opaqueIdSchema,
    kind,
    idempotencyKey: z.string().min(1).max(200),
    payload: z.record(z.string(), z.json()),
    dueAt: utcTimestampSchema,
    priority: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();
const claimSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    queue: queueSchema,
    token: opaqueIdSchema,
    leaseMs: z.number().int().min(1).max(300_000),
    kinds: z.array(kind).max(128),
  })
  .strict();
const fenceSchema = z.object({
  workspaceId: workspaceIdSchema,
  queue: queueSchema,
  id: opaqueIdSchema,
  token: opaqueIdSchema,
});
const resultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("completed"),
      outcome: z.enum(["accepted", "rejected", "unknown"]).optional(),
      receipt: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("retry"),
      delayMs: z.number().int().min(1).max(3_600_000),
      outcome: z.enum(["unknown", "rejected"]).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      outcome: z.enum(["unknown", "rejected"]).optional(),
    })
    .strict(),
]);
export function validateWorkIntent(
  queue: WorkQueue,
  value: WorkIntent,
): WorkIntent {
  queueSchema.parse(queue);
  const intent = intentSchema.parse(value);
  if (
    new TextEncoder().encode(JSON.stringify(intent.payload)).byteLength > 65_536
  )
    throw new Error("Work payload exceeds 64 KiB");
  if (queue === "outbox" && intent.priority !== undefined)
    throw new Error("Outbox ordering follows due time");
  return intent;
}
export function validateWorkClaim(
  input: Parameters<DurableWorkStore["claim"]>[0],
): void {
  claimSchema.parse(input);
}
export function validateWorkResult(lease: WorkLease, result: WorkResult): void {
  fenceSchema.parse(lease);
  resultSchema.parse(result);
  if (lease.queue === "outbox" && result.outcome === undefined)
    throw new Error("Outbox settlement requires an explicit outcome");
}
export function validateWorkCancellation(
  queue: WorkQueue,
  ids: readonly string[],
): void {
  queueSchema.parse(queue);
  z.array(opaqueIdSchema).max(1000).parse(ids);
}
