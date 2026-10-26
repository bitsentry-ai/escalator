import { utcTimestampSchema, type WorkspaceId } from "../../contracts/index.js";
import {
  retentionMaintenanceId,
  retentionMaintenanceKind,
  retentionMaintenancePayloadSchema,
  retentionMaintenanceStateSchema,
  type RetentionMaintenanceState,
} from "./maintenance.js";
export const retiredRetentionWorkDays = 7;
export interface RetiredRetentionWork {
  workspaceId: WorkspaceId;
  id: string;
  kind: string;
  state: string;
  payload: unknown;
  completedAt: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}
/** Exact closed maintenance identities only; malformed and other work remains protected. */
export function retiredRetentionWorkIds(
  scope: WorkspaceId,
  current: RetentionMaintenanceState,
  databaseNow: string,
  candidates: readonly RetiredRetentionWork[],
): string[] {
  utcTimestampSchema.parse(databaseNow);
  retentionMaintenanceStateSchema.parse(current);
  if (current.jobId !== retentionMaintenanceId(scope, current.revision))
    throw new Error("Invalid current retention identity");
  if (current.workspaceId !== scope || candidates.length > 100)
    throw new Error("Invalid retention work cleanup scope or bound");
  const cutoff = Date.parse(databaseNow) - retiredRetentionWorkDays * 86400000;
  const ids = new Set<string>();
  for (const row of candidates) {
    if (row.workspaceId !== scope)
      throw new Error("Foreign retention work candidate");
    const payload = retentionMaintenancePayloadSchema.safeParse(row.payload);
    const completedAt = utcTimestampSchema.safeParse(row.completedAt);
    if (
      row.kind !== retentionMaintenanceKind ||
      row.id === current.jobId ||
      !["completed", "cancelled", "failed"].includes(row.state) ||
      row.leaseToken !== null ||
      row.leaseExpiresAt !== null ||
      !completedAt.success ||
      Date.parse(completedAt.data) > cutoff ||
      !payload.success ||
      payload.data.revision >= current.revision ||
      row.id !== retentionMaintenanceId(scope, payload.data.revision)
    )
      continue;
    if (ids.has(row.id)) throw new Error("Duplicate retention work candidate");
    ids.add(row.id);
  }
  return [...ids];
}
