import { createHash } from "node:crypto";
import {
  signalEventSchema,
  type SignalInput,
  type SignalSource,
} from "../../contracts/index.js";
import type { SignalTransaction } from "./ports.js";
/** The authenticated generic/provider paths share this atomic persistence operation. */
export async function recordSignal(
  tx: SignalTransaction,
  source: SignalSource,
  grantId: string,
  input: SignalInput,
): Promise<{ state: "accepted" | "duplicate"; signalId: string }> {
  const id = createHash("sha256")
    .update(JSON.stringify([tx.workspaceId, source.id, input.eventId]))
    .digest("hex");
  const event = signalEventSchema.parse({
    ...input,
    id,
    workspaceId: tx.workspaceId,
    sourceId: source.id,
    serviceId: source.serviceId,
    environmentId: source.environmentId,
    receivedAt: tx.now,
  });
  if ((await tx.signals.insert(event)) === "duplicate")
    return { state: "duplicate", signalId: id };
  await tx.work.enqueue("job", {
    id: `signal.process:${id}`,
    kind: "signal.process",
    idempotencyKey: `signal.process:${id}`,
    payload: { signalId: id },
    dueAt: tx.now,
  });
  await tx.audit.append({
    id: `signal.accepted:${id}`,
    workspaceId: tx.workspaceId,
    actor: { kind: "system", component: "signal-ingress" },
    action: "signal.accepted",
    subjectType: "signal",
    subjectId: id,
    recordedAt: tx.now,
    metadata: { sourceId: source.id, grantId },
  });
  return { state: "accepted", signalId: id };
}
