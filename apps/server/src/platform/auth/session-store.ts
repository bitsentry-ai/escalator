import session from "express-session";
import type { Pool, PoolClient } from "pg";
import { tokenDigest } from "./credentials.js";

type Done = (error?: unknown) => void;
/** PostgreSQL owns sessions; the fixed installation scope never comes from the cookie. */
export class PostgresSessionStore extends session.Store {
  constructor(
    private readonly pool: Pool,
    private readonly workspaceId: string,
  ) {
    super();
  }
  private async scoped<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        this.workspaceId,
      ]);
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  override get(
    sid: string,
    done: (error: unknown, value?: session.SessionData | null) => void,
  ): void {
    void this.scoped(async (client) => {
      const result = await client.query<{ data: session.SessionData }>(
        `SELECT data FROM escalator_session WHERE workspace_id=$1 AND sid_digest=$2
        AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [this.workspaceId, tokenDigest(sid)],
      );
      return result.rows[0]?.data ?? null;
    }).then(
      (value) => done(null, value),
      () => done(new Error("Session storage unavailable")),
    );
  }
  override set(
    sid: string,
    data: session.SessionData,
    done: Done = () => {},
  ): void {
    const expires = data.cookie.expires;
    if (!expires || !Number.isFinite(new Date(expires).getTime())) {
      done(new Error("Session expiration is required"));
      return;
    }
    void this.scoped(async (client) => {
      const result = await client.query(
        `INSERT INTO escalator_session (workspace_id,sid_digest,data,expires_at)
        VALUES ($1,$2,$3::jsonb,LEAST($4::timestamptz,transaction_timestamp()+interval '8 hours'))
        ON CONFLICT (workspace_id,sid_digest) DO UPDATE SET data=EXCLUDED.data,
        expires_at=LEAST(EXCLUDED.expires_at,escalator_session.created_at+interval '8 hours')
        WHERE escalator_session.revoked_at IS NULL AND escalator_session.expires_at>clock_timestamp()
        RETURNING sid_digest`,
        [this.workspaceId, tokenDigest(sid), JSON.stringify(data), expires],
      );
      if (result.rowCount !== 1) throw new Error("Session is no longer active");
    }).then(
      () => done(),
      () => done(new Error("Session storage unavailable")),
    );
  }
  override destroy(sid: string, done: Done = () => {}): void {
    void this.scoped(async (client) => {
      // A tombstone blocks a concurrent request from re-saving this session ID.
      await client.query(
        `INSERT INTO escalator_session (workspace_id,sid_digest,data,expires_at,revoked_at)
        VALUES ($1,$2,'{}'::jsonb,clock_timestamp(),clock_timestamp())
        ON CONFLICT (workspace_id,sid_digest) DO UPDATE SET data='{}'::jsonb,
        expires_at=clock_timestamp(),revoked_at=clock_timestamp()`,
        [this.workspaceId, tokenDigest(sid)],
      );
    }).then(
      () => done(),
      () => done(new Error("Session storage unavailable")),
    );
  }
  override touch(
    sid: string,
    data: session.SessionData,
    done: Done = () => {},
  ): void {
    const expires = data.cookie.expires;
    if (!expires || !Number.isFinite(new Date(expires).getTime())) {
      done(new Error("Session expiration is required"));
      return;
    }
    void this.scoped(async (client) => {
      await client.query(
        `UPDATE escalator_session SET expires_at=LEAST($3::timestamptz,created_at+interval '8 hours')
        WHERE workspace_id=$1 AND sid_digest=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [this.workspaceId, tokenDigest(sid), expires],
      );
    }).then(
      () => done(),
      () => done(new Error("Session storage unavailable")),
    );
  }
}
