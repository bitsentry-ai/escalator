import type { PoolClient } from "pg";
import {
  deploymentWatchSeconds,
  type WorkspaceId,
  type DeploymentWatchRecord,
} from "@bitsentry-escalator/features/contracts";
import {
  deploymentWatchOverlaps,
  deploymentWatchOverlapVisibleAt,
} from "@bitsentry-escalator/features/application";
type Row = {
  id: string;
  startedAt: string;
  acceptedAt: string;
  finishedAt: string | null;
  timedOutAt: string | null;
};
/** Caller holds the unique service/environment target lock, serializing lifecycle writes. */
export async function readPostgresWatchOverlaps(
  db: PoolClient,
  scope: WorkspaceId,
  watch: DeploymentWatchRecord,
  capturedAt: string,
) {
  const asOf = deploymentWatchOverlapVisibleAt(watch, capturedAt);
  const result = await db.query<Row>(
    `SELECT id, data->>'startedAt' AS "startedAt", data->>'acceptedAt' AS "acceptedAt",
 CASE WHEN (data->'finish'->>'receivedAt')::timestamptz<=$6::timestamptz
 THEN data->'finish'->>'receivedAt' ELSE NULL END AS "finishedAt",
 CASE WHEN (data->>'timedOutAt')::timestamptz<=$6::timestamptz
 THEN data->>'timedOutAt' ELSE NULL END AS "timedOutAt"
FROM escalator_deployment
WHERE workspace_id=$1 AND service_id=$2 AND environment_id=$3 AND id<>$4
 AND started_at<$5::timestamptz AND (data->>'acceptedAt')::timestamptz<=$6::timestamptz
 AND (COALESCE(
   CASE WHEN (data->'finish'->>'receivedAt')::timestamptz<=$6::timestamptz
   THEN (data->'finish'->>'receivedAt')::timestamptz END,
   CASE WHEN (data->>'timedOutAt')::timestamptz<=$6::timestamptz
   THEN (data->>'timedOutAt')::timestamptz END
 ) + $8::integer * interval '1 second' > $7::timestamptz) IS NOT FALSE
ORDER BY started_at DESC,id COLLATE "C" LIMIT 129`,
    [
      scope,
      watch.serviceId,
      watch.environmentId,
      watch.deploymentId,
      watch.endsAt,
      asOf,
      watch.startedAt,
      deploymentWatchSeconds,
    ],
  );
  return deploymentWatchOverlaps(watch, {
    workspaceId: scope,
    serviceId: watch.serviceId,
    environmentId: watch.environmentId,
    asOf,
    rows: result.rows,
  });
}
