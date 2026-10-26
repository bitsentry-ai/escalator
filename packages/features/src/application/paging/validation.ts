import type {
  DeliveryAttempt,
  OperationalPage,
} from "../../contracts/index.js";
import { compareCodeUnits } from "../../contracts/ordering.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The adapter must hold the page row lock before applying these invariants. */
export function validatePageReplacement(
  previous: OperationalPage,
  next: OperationalPage,
): void {
  if (
    next.id !== previous.id ||
    next.workspaceId !== previous.workspaceId ||
    next.revision !== previous.revision + 1 ||
    next.incidentId !== previous.incidentId ||
    next.createdAt !== previous.createdAt ||
    stable(next.policy) !== stable(previous.policy)
  )
    throw new Error("Immutable page fields changed");
  const transitions: Record<
    OperationalPage["state"],
    readonly OperationalPage["state"][]
  > = {
    open: ["open", "exhausted", "acknowledged", "resolved"],
    exhausted: ["exhausted", "acknowledged", "resolved"],
    acknowledged: ["acknowledged", "resolved"],
    resolved: ["resolved"],
  };
  if (
    !transitions[previous.state].includes(next.state) ||
    (previous.acknowledgedBy !== null &&
      (next.acknowledgedBy !== previous.acknowledgedBy ||
        next.acknowledgedAt !== previous.acknowledgedAt)) ||
    (previous.resolvedAt !== null && next.resolvedAt !== previous.resolvedAt) ||
    (previous.state === "resolved" &&
      next.acknowledgedBy !== previous.acknowledgedBy)
  )
    throw new Error("Page lifecycle cannot move backwards or change its owner");
}

/** Each attempt has its own fenced identity; old results never target a newer attempt. */
export function validateAttemptCompletion(
  previous: DeliveryAttempt,
  next: DeliveryAttempt,
): void {
  if (
    next.id !== previous.id ||
    next.workspaceId !== previous.workspaceId ||
    next.deliveryId !== previous.deliveryId ||
    next.attempt !== previous.attempt ||
    next.claimToken !== previous.claimToken ||
    next.startedAt !== previous.startedAt ||
    next.outcome === "in_flight"
  )
    throw new Error("Immutable attempt fields changed");
}
