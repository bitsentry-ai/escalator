import type { Pool, PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  validateWorkClaim,
  validateWorkResult,
} from "@bitsentry-escalator/features/application";
import type {
  DurableWorkStore,
  WorkLease,
  WorkQueue,
  WorkResult,
} from "@bitsentry-escalator/features/application";

function table(queue: WorkQueue): string {
  if (queue === "job") return "escalator_job";
  if (queue === "outbox") return "escalator_outbox";
  throw new Error("Invalid work queue");
}
/** The pool belongs to the host. Only short claim/settle transactions live here. */
export class PostgresWorkStore implements DurableWorkStore {
  constructor(private readonly pool: Pool) {}
  private async scoped<T>(
    workspaceId: WorkspaceId,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async claim(
    input: Parameters<DurableWorkStore["claim"]>[0],
  ): Promise<WorkLease | undefined> {
    validateWorkClaim(input);
    const relation = table(input.queue);
    if (!input.kinds.length) return undefined;
    return this.scoped(input.workspaceId, async (client) => {
      const result = await client.query<{
        id: string;
        kind: string;
        payload: WorkLease["payload"];
        attempt_count: number;
        due_at: Date;
        lease_expires_at: Date;
      }>(
        `WITH candidate AS (
        SELECT id FROM ${relation}
        WHERE workspace_id = $1 AND kind = ANY($2::text[])
          AND ((state = 'pending' AND due_at <= clock_timestamp())
            OR (state = 'running' AND lease_expires_at <= clock_timestamp()))
        ORDER BY ${input.queue === "job" ? "priority DESC, " : ""}due_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ${relation} AS work SET
        state = 'running', lease_token = $3,
        lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
        attempt_count = work.attempt_count + 1, updated_at = clock_timestamp()
        ${input.queue === "outbox" ? ", outcome = CASE WHEN work.state = 'running' THEN 'unknown' ELSE work.outcome END" : ""}
      FROM candidate WHERE work.workspace_id = $1 AND work.id = candidate.id
      RETURNING work.id, work.kind, work.payload, work.attempt_count, work.due_at, work.lease_expires_at`,
        [input.workspaceId, [...input.kinds], input.token, input.leaseMs],
      );
      const row = result.rows[0];
      return row
        ? {
            workspaceId: input.workspaceId,
            queue: input.queue,
            id: row.id,
            kind: row.kind,
            payload: row.payload,
            token: input.token,
            attempt: row.attempt_count,
            dueAt: row.due_at.toISOString(),
            leaseExpiresAt: row.lease_expires_at.toISOString(),
          }
        : undefined;
    });
  }
  async settle(lease: WorkLease, result: WorkResult): Promise<boolean> {
    validateWorkResult(lease, result);
    const relation = table(lease.queue);
    return this.scoped(lease.workspaceId, async (client) => {
      // Acquire the row lock before checking wall-clock expiry; a lock wait must
      // not let a previously evaluated expiry predicate authorize stale completion.
      await client.query(
        `SELECT id FROM ${relation} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [lease.workspaceId, lease.id],
      );
      const state =
        result.state === "retry" || result.state === "wait"
          ? "pending"
          : result.state;
      const delay =
        result.state === "retry" || result.state === "wait"
          ? result.delayMs
          : null;
      const parameters: unknown[] = [
        lease.workspaceId,
        lease.id,
        lease.token,
        state,
        delay,
      ];
      let outcome = "";
      if (lease.queue === "outbox") {
        parameters.push(
          result.outcome ?? null,
          result.state === "completed" ? (result.receipt ?? null) : null,
        );
        outcome = ", outcome = $6, provider_receipt = $7";
      }
      const resetAttempts =
        result.state === "wait" ? ", attempt_count = 0" : "";
      const updated = await client.query(
        `UPDATE ${relation} SET
        state = $4, lease_token = NULL, lease_expires_at = NULL,
        due_at = CASE WHEN $5::integer IS NULL THEN due_at ELSE clock_timestamp() + ($5::integer * interval '1 millisecond') END,
        updated_at = clock_timestamp(),
        completed_at = CASE WHEN $4 = 'pending' THEN NULL ELSE clock_timestamp() END ${outcome}${resetAttempts}
        WHERE workspace_id = $1 AND id = $2 AND state = 'running'
          AND lease_token = $3 AND lease_expires_at > clock_timestamp()`,
        parameters,
      );
      return updated.rowCount === 1;
    });
  }
}
