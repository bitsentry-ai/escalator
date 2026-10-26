import {
  opaqueIdSchema,
  type OperationalIncident,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { compareCodeUnits } from "../../contracts/ordering.js";

/** Incident lists show open incidents first, then newest; the cursor carries the whole sort key. */
export interface IncidentOrderKey {
  resolved: boolean;
  /** Milliseconds since epoch; SQL stores compare opened_at truncated to milliseconds. */
  openedAt: number;
  id: string;
}
export function incidentOrderKey(
  incident: OperationalIncident,
): IncidentOrderKey {
  return {
    resolved: incident.resolvedAt !== null,
    openedAt: Date.parse(incident.openedAt),
    id: incident.id,
  };
}
export function compareIncidentOrder(
  a: IncidentOrderKey,
  b: IncidentOrderKey,
): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  if (a.openedAt !== b.openedAt) return b.openedAt - a.openedAt;
  return compareCodeUnits(a.id, b.id);
}
export function incidentCursor(incident: OperationalIncident): string {
  const key = incidentOrderKey(incident);
  return `${key.resolved ? "r" : "o"}.${key.openedAt}.${key.id}`;
}
export function parseIncidentCursor(cursor: string): IncidentOrderKey {
  const match = /^([or])\.(\d{1,15})\.(.+)$/.exec(cursor);
  if (!match || !opaqueIdSchema.safeParse(match[3]).success)
    throw new PersistenceError("invalid_page");
  return {
    resolved: match[1] === "r",
    openedAt: Number(match[2]),
    id: match[3],
  };
}
