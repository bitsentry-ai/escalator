import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  retiredRetentionWorkDays,
  retiredRetentionWorkIds,
  type RetentionMaintenanceState,
  type RetiredRetentionWork,
} from "@bitsentry-escalator/features/application";
type Row = Omit<RetiredRetentionWork, "completedAt" | "leaseExpiresAt"> & {
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
};
/** Called with the schedule/current claim locked, before any receipt-accounting lock. */
export async function postgresRetireMaintenanceWork(
  db: PoolClient,
  scope: WorkspaceId,
  current: RetentionMaintenanceState,
  now: string,
): Promise<number> {
  const cutoff = new Date(
    Date.parse(now) - retiredRetentionWorkDays * 86400000,
  ).toISOString();
  const result = await db.query<Row>(
    `SELECT workspace_id AS "workspaceId",id,kind,state,payload,
    completed_at AS "completedAt",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt"
    FROM escalator_job WHERE workspace_id=$1 AND kind='retention.sweep' AND id<>$2
      AND state IN ('completed','cancelled','failed') AND completed_at <= $3::timestamptz
    ORDER BY completed_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`,
    [scope, current.jobId, cutoff],
  );
  const ids = retiredRetentionWorkIds(
    scope,
    current,
    now,
    result.rows.map((row) => ({
      ...row,
      completedAt: row.completedAt?.toISOString() ?? null,
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    })),
  );
  if (!ids.length) return 0;
  const removed = await db.query<{ id: string }>(
    `DELETE FROM escalator_job
    WHERE workspace_id=$1 AND id=ANY($2::text[]) AND id<>$3 AND kind='retention.sweep' RETURNING id`,
    [scope, ids, current.jobId],
  );
  if (removed.rows.length !== ids.length)
    throw new Error("Retention work deletion mismatch");
  return ids.length;
}
