import {
  escalationPolicySchema,
  utcTimestampSchema,
  type EscalationPolicy,
  type PolicySnapshot,
  type DeepReadonly,
  type EscalationStep,
  type EscalationDecision,
} from "../../contracts/index.js";
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
/** Parse copies caller-owned arrays before freezing the immutable page policy. */
export function snapshotPolicy(value: unknown): PolicySnapshot {
  return freeze(escalationPolicySchema.parse(value));
}
/** Terminal bounds and operator recipients must be chosen explicitly by the operator. */
export function defaultEscalationPolicy(
  input: Omit<EscalationPolicy, "steps">,
): PolicySnapshot {
  const minutes = [0, 2, 7, 12, 17];
  return snapshotPolicy({
    ...input,
    steps: minutes.map((minute, index) => ({
      id: `step-${index}`,
      offsetMs: minute * 60_000,
      target: index < 3 ? "primary" : index === 3 ? "peer" : "fallback",
    })),
  });
}
function timestamp(value: string): number {
  return Date.parse(utcTimestampSchema.parse(value));
}
export function escalationSteps(
  snapshot: PolicySnapshot,
  createdAt: string,
): EscalationStep[] {
  const policy = escalationPolicySchema.parse(snapshot);
  const created = timestamp(createdAt);
  const steps: EscalationStep[] = policy.steps.map((step) => ({
    id: step.id,
    target: step.target,
    dueAt: new Date(created + step.offsetMs).toISOString(),
  }));
  const end = policy.steps.at(-1)!.offsetMs;
  for (let reminder = 1; reminder <= policy.terminal.maxReminders; reminder++)
    steps.push({
      id: `reminder:${reminder}`,
      target: "fallback",
      dueAt: new Date(
        created + end + reminder * policy.terminal.reminderIntervalMs,
      ).toISOString(),
    });
  steps.push({
    id: "terminal",
    target: "operator",
    dueAt: new Date(
      created +
        end +
        (policy.terminal.maxReminders + 1) * policy.terminal.reminderIntervalMs,
    ).toISOString(),
  });
  return steps;
}
/**
 * recordedStepIds includes durable dispatch intents and skipped steps, not provider successes.
 * The host persists a decision atomically; retries reuse the step's frozen recipients/outbox.
 * After downtime only the current overdue level is dispatched. Exhaustion never resolves a page.
 */
export function planEscalation(input: {
  policy: PolicySnapshot;
  createdAt: string;
  now: string;
  state: "open" | "exhausted" | "acknowledged" | "resolved";
  recordedStepIds: readonly string[];
}): EscalationDecision {
  const steps = escalationSteps(input.policy, input.createdAt);
  const now = timestamp(input.now);
  const recorded = new Set(input.recordedStepIds);
  if ([...recorded].some((id) => !steps.some((step) => step.id === id)))
    throw new Error("Unknown escalation step");
  const dueIndex = steps.reduce(
    (latest, step, index) => (timestamp(step.dueAt) <= now ? index : latest),
    -1,
  );
  const recordedIndex = steps.reduce(
    (latest, step, index) => (recorded.has(step.id) ? index : latest),
    -1,
  );
  const index = Math.max(dueIndex, recordedIndex);
  const exhausted =
    input.state === "exhausted" || index >= input.policy.steps.length - 1;
  const pending = steps.filter((step) => !recorded.has(step.id));
  if (input.state === "acknowledged" || input.state === "resolved")
    return {
      kind: "cancel",
      cancel: pending.map((step) => step.id),
      exhausted,
    };
  const current = steps[index];
  const next =
    steps.slice(index + 1).find((step) => !recorded.has(step.id))?.dueAt ??
    null;
  const skip = steps
    .slice(0, Math.max(0, index))
    .filter((step) => !recorded.has(step.id))
    .map((step) => step.id);
  // Recorded progress is monotonic, including after a database clock adjustment.
  if (!current || recorded.has(current.id))
    return { kind: "wait", dueAt: next, skip, exhausted };
  return { kind: "dispatch", step: current, skip, nextDueAt: next, exhausted };
}
