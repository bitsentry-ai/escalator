import type { PoolClient } from "pg";
import {
  watchCadenceLeaseSchema,
  watchCadenceReceiptSchema,
  type WorkspaceId,
  type WatchCadenceLease,
  type WatchCadenceReceipt,
} from "@bitsentry-escalator/features/contracts";
import {
  PersistenceError,
  type WatchCadenceStore,
} from "@bitsentry-escalator/features/application";
const encode = (value: WatchCadenceLease | WatchCadenceReceipt) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "workspaceId"),
    ),
  );
/** Called within the probe's capacity/target/source lock and the host's scoped transaction. */
export function postgresWatchCadenceStore(
  db: PoolClient,
  scope: WorkspaceId,
): WatchCadenceStore {
  function bound(value: WatchCadenceLease | WatchCadenceReceipt) {
    if (value.workspaceId !== scope)
      throw new PersistenceError("scope_violation");
  }
  return {
    async receipt(deploymentId, probeId) {
      const result = await db.query<{ data: object }>(
        "SELECT data FROM escalator_watch_cadence_receipt WHERE workspace_id=$1 AND deployment_id=$2 AND probe_id=$3",
        [scope, deploymentId, probeId],
      );
      return result.rows[0]
        ? watchCadenceReceiptSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async insertReceipt(value) {
      bound(value);
      await db.query(
        `INSERT INTO escalator_watch_cadence_receipt
        (workspace_id,deployment_id,target_id,probe_id,source_id,service_id,environment_id,recorded_at,decision,generation_id,applied_probe_version,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb)`,
        [
          scope,
          value.deploymentId,
          value.targetId,
          value.probeId,
          value.sourceId,
          value.serviceId,
          value.environmentId,
          value.recordedAt,
          value.decision,
          value.generationId,
          value.appliedProbeVersion,
          encode(value),
        ],
      );
    },
    async lease(probeId) {
      const result = await db.query<{ data: object }>(
        "SELECT data FROM escalator_watch_cadence_lease WHERE workspace_id=$1 AND probe_id=$2",
        [scope, probeId],
      );
      return result.rows[0]
        ? watchCadenceLeaseSchema.parse({
            ...result.rows[0].data,
            workspaceId: scope,
          })
        : undefined;
    },
    async putLease(value, expected) {
      bound(value);
      const result =
        expected === null
          ? await db.query(
              `INSERT INTO escalator_watch_cadence_lease
            (workspace_id,probe_id,target_id,source_id,service_id,environment_id,generation_id,generation_deployment_id,revision,original_interval_seconds,applied_probe_version,created_at,restore_at,data)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::jsonb)
            ON CONFLICT(workspace_id,probe_id) DO NOTHING`,
              [
                scope,
                value.probeId,
                value.targetId,
                value.sourceId,
                value.serviceId,
                value.environmentId,
                value.generationId,
                value.generationDeploymentId,
                value.revision,
                value.originalIntervalSeconds,
                value.appliedProbeVersion,
                value.createdAt,
                value.restoreAt,
                encode(value),
              ],
            )
          : await db.query(
              `UPDATE escalator_watch_cadence_lease SET revision=$4,restore_at=$5::timestamptz,data=$6::jsonb
            WHERE workspace_id=$1 AND probe_id=$2 AND revision=$3 AND generation_id=$7`,
              [
                scope,
                value.probeId,
                expected,
                value.revision,
                value.restoreAt,
                encode(value),
                value.generationId,
              ],
            );
      return result.rowCount === 1;
    },
    async removeLease(probeId, generationId, expected) {
      const result = await db.query(
        "DELETE FROM escalator_watch_cadence_lease WHERE workspace_id=$1 AND probe_id=$2 AND generation_id=$3 AND revision=$4",
        [scope, probeId, generationId, expected],
      );
      return result.rowCount === 1;
    },
  };
}
