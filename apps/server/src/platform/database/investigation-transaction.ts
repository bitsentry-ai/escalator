import type { Pool, PoolClient } from "pg";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
/** Bound acquisition, callback work and commit together. Destroy a timed-out connection;
 * never return it to the pool with a transaction still running. A lost commit reply is
 * intentionally an error: callers must treat publication as uncertain, not retry it.
 */
export async function investigationTransaction<T>(
  pool: Pool,
  scope: WorkspaceId,
  work: (db: PoolClient) => Promise<T>,
  timeoutMs = 10000,
): Promise<T> {
  workspaceIdSchema.parse(scope);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000)
    throw new Error("Invalid investigation transaction deadline");
  let db: PoolClient | undefined;
  let released = false;
  let finished = false;
  const release = (destroy = false) => {
    if (db && !released) {
      released = true;
      db.release(destroy);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      finished = true;
      try {
        release(true);
      } catch {
        /* Deadline rejection still settles the caller. */
      }
      reject(new Error("Investigation transaction timed out"));
    }, timeoutMs);
  });
  const operation = (async () => {
    db = await pool.connect();
    if (finished) {
      release(true);
      throw new Error("Investigation connection arrived after deadline");
    }
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [scope]);
      const value = await work(db);
      if (finished) throw new Error("Investigation transaction timed out");
      await db.query("COMMIT");
      return value;
    } catch (error) {
      if (!released) {
        try {
          await db.query("ROLLBACK");
        } catch {
          release(true);
        }
      }
      throw error;
    }
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    finished = true;
    clearTimeout(timer);
    release();
  }
}
