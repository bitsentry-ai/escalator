import type { Pool, PoolClient } from "pg";
/** Private facade for rule transactions: acquisition, callback and commit share
 * one deadline. Late clients are destroyed; expired callbacks cannot issue SQL.
 * Existing foundation callers and their pool configuration are unchanged.
 */
export async function withBoundedRulePool<T>(
  pool: Pool,
  work: (bounded: Pool) => Promise<T>,
  timeoutMs = 10000,
  monotonicNow: () => number = () => performance.now(),
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000)
    throw new Error("Invalid rule transaction deadline");
  const expiresAt = monotonicNow() + timeoutMs;
  let client: PoolClient | undefined;
  let released = false;
  let expired = false;
  let acquired = false;
  const release = (destroy = false) => {
    if (client && !released) {
      released = true;
      client.release(destroy);
    }
  };
  // Timers cannot run while JavaScript is busy. Check elapsed time at every SQL
  // boundary as well, so a delayed timeout callback cannot permit a late COMMIT.
  const assertDeadline = () => {
    if (expired || monotonicNow() >= expiresAt) {
      expired = true;
      release(true);
      throw new Error("Rule transaction deadline exceeded");
    }
  };
  const bounded = new Proxy(pool, {
    get(_target, key) {
      if (key === "connect")
        return async () => {
          assertDeadline();
          if (acquired)
            throw new Error("Rule transaction connection is unavailable");
          acquired = true;
          client = await pool.connect();
          assertDeadline();
          return new Proxy(client, {
            get(connection, method) {
              if (method === "release") return release;
              if (method === "query")
                return (...args: unknown[]) => {
                  assertDeadline();
                  if (released)
                    throw new Error("Rule transaction deadline exceeded");
                  return Reflect.apply(connection.query, connection, args);
                };
              const value = Reflect.get(connection, method);
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          });
        };
      throw new Error(
        "Only connection acquisition is available in a rule transaction",
      );
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      try {
        release(true);
      } catch {
        /* Reject even if client cleanup fails. */
      }
      reject(new Error("Rule transaction deadline exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const value = await work(bounded);
        assertDeadline();
        return value;
      }),
      deadline,
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
    // Foundation normally releases after COMMIT/ROLLBACK. An unexpected escape
    // destroys the client rather than returning an open transaction to the pool.
    release(true);
  }
}
