import type { Pool, PoolClient } from "pg";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  watchdogJobPrefix,
  type OperationalHealthReader,
  type QueueHealthSnapshot,
} from "@bitsentry-escalator/features/application";

/** A late pool checkout is returned even if the request has already timed out. */
function acquire(
  pending: Promise<PoolClient>,
  signal: AbortSignal,
): Promise<PoolClient> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true;
      reject(new Error("Health connection unavailable"));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (client) => {
        signal.removeEventListener("abort", abort);
        if (finished) client.release();
        else {
          finished = true;
          resolve(client);
        }
      },
      () => {
        signal.removeEventListener("abort", abort);
        if (!finished) {
          finished = true;
          reject(new Error("Health connection unavailable"));
        }
      },
    );
  });
}
/** Read-only, scoped, short-lived snapshot; the pool belongs to the host. */
export class PostgresHealthReader implements OperationalHealthReader {
  private acquiring = false;
  constructor(private readonly pool: Pool) {}
  async read(
    workspaceId: WorkspaceId,
    signal: AbortSignal,
  ): Promise<QueueHealthSnapshot> {
    const scope = workspaceIdSchema.parse(workspaceId);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const checkout = AbortSignal.any([bounded, AbortSignal.timeout(1000)]);
    checkout.throwIfAborted();
    if (this.acquiring) throw new Error("Health connection unavailable");
    this.acquiring = true;
    const pending = Promise.resolve().then(() => {
      checkout.throwIfAborted();
      return this.pool.connect();
    });
    void pending.then(
      () => {
        this.acquiring = false;
      },
      () => {
        this.acquiring = false;
      },
    );
    const client = await acquire(pending, checkout);
    let released = false;
    const abort = () => {
      if (!released) {
        released = true;
        client.release(true);
      }
    };
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '1s'");
      await client.query("SET LOCAL lock_timeout = '500ms'");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        scope,
      ]);
      bounded.throwIfAborted();
      const { rows } = await client.query<{
        database_now: Date;
        oldest_job: Date | null;
        oldest_outbox: Date | null;
        oldest_paging: Date | null;
      }>(
        `
        SELECT transaction_timestamp() AS database_now,
          (SELECT min(due_at) FROM escalator_job WHERE workspace_id=$1
            AND state IN ('pending','running') AND due_at<=transaction_timestamp()
            AND left(kind, length($2))<>$2) AS oldest_job,
          (SELECT min(due_at) FROM escalator_outbox WHERE workspace_id=$1
            AND state IN ('pending','running') AND due_at<=transaction_timestamp()) AS oldest_outbox,
          (SELECT min(due_at) FROM escalator_job WHERE workspace_id=$1
            AND state IN ('pending','running') AND due_at<=transaction_timestamp()
            AND kind LIKE 'paging.%') AS oldest_paging
        FROM escalator_workspace WHERE id=$1`,
        [scope, watchdogJobPrefix],
      );
      bounded.throwIfAborted();
      if (rows.length !== 1) throw new Error("Health workspace unavailable");
      const row = rows[0];
      const result = {
        databaseNow: row.database_now.toISOString(),
        oldestDueJobAt: row.oldest_job?.toISOString() ?? null,
        oldestDueOutboxAt: row.oldest_outbox?.toISOString() ?? null,
        oldestDuePagingAt: row.oldest_paging?.toISOString() ?? null,
      };
      await client.query("COMMIT");
      bounded.throwIfAborted();
      return result;
    } catch {
      // Destroying a failed/aborted read also rolls its transaction back.
      abort();
      throw new Error("Operational health database unavailable");
    } finally {
      bounded.removeEventListener("abort", abort);
      if (!released) {
        released = true;
        client.release();
      }
    }
  }
}
