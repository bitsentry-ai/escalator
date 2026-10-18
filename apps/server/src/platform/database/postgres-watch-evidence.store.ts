import type { PoolClient } from "pg";
import type {
  WorkspaceId,
  DeploymentEntry,
  DeploymentWatchRecord,
  DeploymentBaseline,
} from "@bitsentry-escalator/features/contracts";
import {
  watchEvidenceContext,
  baselineProjectionSchema,
} from "@bitsentry-escalator/features/application";
import {
  watchSourceLocksSql,
  deploymentWatchSql,
} from "./deployment-baseline-sql.js";
/** Uses the caller's scoped transaction. Source locks precede work/accounting locks. */
export async function readPostgresWatchEvidence(
  db: PoolClient,
  scope: WorkspaceId,
  entry: DeploymentEntry,
  rawWatch: DeploymentWatchRecord,
  baseline: DeploymentBaseline | undefined,
) {
  const { watch, sourceIds } = watchEvidenceContext(
    scope,
    entry,
    rawWatch,
    baseline,
  );
  const binding = [scope, watch.serviceId, watch.environmentId];
  const locked = await db.query<{ id: string }>(watchSourceLocksSql, [
    ...binding,
    sourceIds,
  ]);
  const result = await db.query<{ snapshot: unknown }>(deploymentWatchSql, [
    ...binding,
    watch.startedAt,
    watch.endsAt,
    locked.rows.map((row) => row.id),
  ]);
  return baselineProjectionSchema.parse(result.rows[0]?.snapshot);
}
