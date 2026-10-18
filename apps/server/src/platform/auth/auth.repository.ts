import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Role,
  WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import { roleSchema } from "@bitsentry-escalator/features/contracts";
import {
  accountProofSchema,
  digestSchema,
  loginSchema,
  persistedRegistrationSchema,
  workspaceNameSchema,
} from "./schemas.js";
import { AuthenticationError } from "./credentials.js";

export interface AccountRecord {
  id: string;
  login: string;
  passwordHash: string;
  enabled: boolean;
  authVersion: number;
  role: Role;
  displayName: string;
  timeZone: string;
  totpSecretId: string | null;
  totpPendingSecretId: string | null;
  totpPendingExpiresAt: Date | null;
  totpLastStep: number | null;
}
interface AccountRow {
  id: string;
  login: string;
  password_hash: string;
  enabled: boolean;
  auth_version: number;
  role: Role;
  display_name: string;
  time_zone: string;
  totp_secret_id: string | null;
  totp_pending_secret_id: string | null;
  totp_pending_expires_at: Date | null;
  totp_last_step: string | null;
}
const accountColumns = `a.id,a.login,a.password_hash,(a.enabled AND r.enabled) AS enabled,
 a.auth_version,r.role,r.display_name,r.time_zone,a.totp_secret_id,a.totp_pending_secret_id,
 a.totp_pending_expires_at,a.totp_last_step`;
function account(row: AccountRow | undefined): AccountRecord | undefined {
  return row
    ? {
        id: row.id,
        login: row.login,
        passwordHash: row.password_hash,
        enabled: row.enabled,
        authVersion: row.auth_version,
        role: row.role,
        displayName: row.display_name,
        timeZone: row.time_zone,
        totpSecretId: row.totp_secret_id,
        totpPendingSecretId: row.totp_pending_secret_id,
        totpPendingExpiresAt: row.totp_pending_expires_at,
        totpLastStep:
          row.totp_last_step === null ? null : Number(row.totp_last_step),
      }
    : undefined;
}
export interface AccountProof {
  accountId: string;
  authVersion: number;
}
export interface Registration {
  tokenDigest: string;
  login: string;
  passwordHash: string;
  displayName: string;
  timeZone: string;
}
/** Standalone-only authentication persistence. Scope comes from host configuration. */
export class PostgresAuthRepository {
  constructor(
    private readonly pool: Pool,
    readonly workspaceId: WorkspaceId,
  ) {}
  private async transaction<T>(
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
  private async audit(
    client: PoolClient,
    action: string,
    subjectId: string,
    actorId?: string,
    subjectType = "account",
    metadata: { tokenId?: string; role?: Role } = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO escalator_audit
      (workspace_id,id,actor,action,subject_type,subject_id,recorded_at,metadata)
      VALUES ($1,$2,$3::jsonb,$4,$6,$5,clock_timestamp(),$7::jsonb)`,
      [
        this.workspaceId,
        randomUUID(),
        JSON.stringify(
          actorId
            ? { kind: "responder", responderId: actorId }
            : { kind: "system", component: "local-auth" },
        ),
        action,
        subjectId,
        subjectType,
        JSON.stringify(metadata),
      ],
    );
  }
  async findByLogin(login: string): Promise<AccountRecord | undefined> {
    login = loginSchema.parse(login);
    return this.transaction(async (client) =>
      account(
        (
          await client.query<AccountRow>(
            `SELECT ${accountColumns} FROM escalator_account a JOIN escalator_responder r
       ON r.workspace_id=a.workspace_id AND r.id=a.id WHERE a.workspace_id=$1 AND a.login=$2`,
            [this.workspaceId, login],
          )
        ).rows[0],
      ),
    );
  }
  async findById(id: string): Promise<AccountRecord | undefined> {
    return this.transaction(async (client) =>
      account(
        (
          await client.query<AccountRow>(
            `SELECT ${accountColumns} FROM escalator_account a JOIN escalator_responder r
       ON r.workspace_id=a.workspace_id AND r.id=a.id WHERE a.workspace_id=$1 AND a.id=$2`,
            [this.workspaceId, id],
          )
        ).rows[0],
      ),
    );
  }
  /** Local operator command only. Reissue an unused bootstrap token, never an existing account. */
  async bootstrap(
    name: string,
    digest: string,
    expiresAt: Date,
  ): Promise<void> {
    name = workspaceNameSchema.parse(name);
    digest = digestSchema.parse(digest);
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO escalator_workspace(id,name,created_at,updated_at)
        VALUES ($1,$2,transaction_timestamp(),transaction_timestamp()) ON CONFLICT(id) DO NOTHING`,
        [this.workspaceId, name],
      );
      const result = await client.query(
        `INSERT INTO escalator_auth_token
        (workspace_id,id,digest,purpose,role,expires_at)
        SELECT $1,$2,$3,'bootstrap','administrator',$4 WHERE NOT EXISTS
        (SELECT 1 FROM escalator_account WHERE workspace_id=$1)
        ON CONFLICT (workspace_id) WHERE purpose='bootstrap' DO UPDATE
        SET digest=EXCLUDED.digest,expires_at=EXCLUDED.expires_at
        WHERE escalator_auth_token.consumed_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM escalator_account WHERE workspace_id=$1) RETURNING id`,
        [this.workspaceId, randomUUID(), digest, expiresAt],
      );
      if (result.rowCount !== 1) throw new AuthenticationError();
      await this.audit(
        client,
        "auth.bootstrap-issued",
        this.workspaceId,
        undefined,
        "workspace",
      );
    });
  }
  async register(input: Registration): Promise<string> {
    input = persistedRegistrationSchema.parse(input);
    return this.transaction(async (client) => {
      // Validate expiry after the row lock: a lock wait cannot extend token validity.
      await client.query(
        "SELECT id FROM escalator_auth_token WHERE workspace_id=$1 AND digest=$2 FOR UPDATE",
        [this.workspaceId, input.tokenDigest],
      );
      const result = await client.query<{
        id: string;
        role: Role;
        purpose: string;
      }>(
        `SELECT id,role,purpose FROM escalator_auth_token WHERE workspace_id=$1 AND digest=$2
        AND purpose IN ('bootstrap','invite') AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [this.workspaceId, input.tokenDigest],
      );
      const token = result.rows[0];
      if (!token) throw new AuthenticationError();
      if (
        token.purpose === "bootstrap" &&
        (
          await client.query(
            "SELECT 1 FROM escalator_account WHERE workspace_id=$1 LIMIT 1",
            [this.workspaceId],
          )
        ).rowCount
      )
        throw new AuthenticationError();
      const id = randomUUID();
      await client.query(
        `INSERT INTO escalator_responder
        (workspace_id,id,host_user_id,display_name,time_zone,role,enabled,created_at,updated_at)
        VALUES ($1,$2,$2,$3,$4,$5,true,transaction_timestamp(),transaction_timestamp())`,
        [this.workspaceId, id, input.displayName, input.timeZone, token.role],
      );
      await client.query(
        `INSERT INTO escalator_account(workspace_id,id,login,password_hash) VALUES ($1,$2,$3,$4)`,
        [this.workspaceId, id, input.login, input.passwordHash],
      );
      await client.query(
        "UPDATE escalator_auth_token SET consumed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
        [this.workspaceId, token.id],
      );
      await this.audit(client, "account.created", id, id, "account", {
        tokenId: token.id,
        role: token.role,
      });
      return id;
    });
  }
  async invite(
    proof: AccountProof,
    digest: string,
    role: Role,
    expiresAt: Date,
  ): Promise<string> {
    proof = accountProofSchema.parse(proof);
    digest = digestSchema.parse(digest);
    role = roleSchema.parse(role);
    return this.transaction(async (client) => {
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO escalator_auth_token(workspace_id,id,digest,purpose,role,expires_at)
        SELECT $1,$2,$3,'invite',$4,$5 FROM escalator_account a JOIN escalator_responder r
        ON r.workspace_id=a.workspace_id AND r.id=a.id WHERE a.workspace_id=$1 AND a.id=$6
        AND a.enabled AND r.enabled AND a.auth_version=$7 AND r.role='administrator' RETURNING id`,
        [
          this.workspaceId,
          id,
          digest,
          role,
          expiresAt,
          proof.accountId,
          proof.authVersion,
        ],
      );
      if (result.rowCount !== 1) throw new AuthenticationError();
      await this.audit(
        client,
        "auth.invitation-issued",
        id,
        proof.accountId,
        "auth-token",
        { role },
      );
      return id;
    });
  }
  /** Atomic persistent bucket. Call the IP bucket before the account bucket. */
  async takeRateSlot(
    digest: string,
    maximum: number,
    windowSeconds: number,
  ): Promise<boolean> {
    digest = digestSchema.parse(digest);
    if (
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 1000 ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 3600
    )
      throw new Error("Invalid authentication rate policy");
    return this.transaction(async (client) => {
      const result = await client.query<{ attempts: number }>(
        `INSERT INTO escalator_auth_rate(workspace_id,bucket_digest,window_start,attempts)
        VALUES ($1,$2,clock_timestamp(),1) ON CONFLICT(workspace_id,bucket_digest) DO UPDATE SET
        attempts=CASE WHEN escalator_auth_rate.window_start <= clock_timestamp()-($3::integer*interval '1 second')
        THEN 1 ELSE LEAST(escalator_auth_rate.attempts+1,$4::integer+1) END,
        window_start=CASE WHEN escalator_auth_rate.window_start <= clock_timestamp()-($3::integer*interval '1 second')
        THEN clock_timestamp() ELSE escalator_auth_rate.window_start END RETURNING attempts`,
        [this.workspaceId, digest, windowSeconds, maximum],
      );
      return result.rows[0].attempts <= maximum;
    });
  }
}
