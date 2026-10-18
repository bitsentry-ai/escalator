import type { PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  validateWorkIntent,
  validateWorkFence,
  PersistenceError,
  validateWorkCancellation,
  type WorkWriter,
} from "@bitsentry-escalator/features/application";

/** Uses the caller's existing transaction; it must never start/commit its own. */
export function postgresWorkWriter(
  client: PoolClient,
  workspaceId: WorkspaceId,
): WorkWriter {
  return {
    async lockClaim(lease) {
      validateWorkFence(lease);
      if (lease.workspaceId !== workspaceId)
        throw new PersistenceError("scope_violation");
      const relation =
        lease.queue === "job" ? "escalator_job" : "escalator_outbox";
      type Row = {
        id: string;
        kind: string;
        payload: typeof lease.payload;
        attempt: number;
        due_at: Date;
        lease_expires_at: Date;
      };
      const sql = `SELECT id, kind, payload, attempt_count AS attempt, due_at, lease_expires_at FROM ${relation}
        WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_token=$3
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;
      await client.query(
        `SELECT id FROM ${relation} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, lease.id],
      );
      const result = await client.query<Row>(sql, [
        workspaceId,
        lease.id,
        lease.token,
      ]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        workspaceId: workspaceId,
        queue: lease.queue,
        id: row.id,
        kind: row.kind,
        payload: row.payload,
        token: lease.token,
        attempt: row.attempt,
        dueAt: row.due_at.toISOString(),
        leaseExpiresAt: row.lease_expires_at.toISOString(),
      };
    },
    async enqueue(queue, input) {
      const intent = validateWorkIntent(queue, input);
      const relation = queue === "job" ? "escalator_job" : "escalator_outbox";
      const parameters: unknown[] = [
        workspaceId,
        intent.id,
        intent.kind,
        intent.idempotencyKey,
        JSON.stringify(intent.payload),
        intent.dueAt,
      ];
      if (queue === "job") parameters.push(intent.priority ?? 0);
      const result = await client.query(
        `INSERT INTO ${relation}
        (workspace_id, id, kind, idempotency_key, payload, due_at${queue === "job" ? ", priority" : ""})
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz${queue === "job" ? ",$7" : ""})
        ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING RETURNING id`,
        parameters,
      );
      return result.rowCount === 1 ? "inserted" : "duplicate";
    },
    async cancel(queue, ids) {
      validateWorkCancellation(queue, ids);
      if (!ids.length) return 0;
      const relation = queue === "job" ? "escalator_job" : "escalator_outbox";
      const result = await client.query(
        `UPDATE ${relation} SET state = 'cancelled',
        lease_token = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND id = ANY($2::text[]) AND state IN ('pending','running')`,
        [workspaceId, [...ids]],
      );
      return result.rowCount ?? 0;
    },
  };
}
