import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  PostgresAuthRepository,
  type AccountProof,
} from "./auth.repository.js";
import {
  AuthenticationError,
  issueToken,
  newTotpEnrollment,
  tokenDigest,
  verifyTotp,
} from "./credentials.js";
import { accountProofSchema, digestSchema } from "./schemas.js";
import { SecretKeyRing, type SecretEnvelope } from "../secrets/keyring.js";
import type { AccountSecurity } from "./auth.service.js";

interface LockedAccount {
  id: string;
  login: string;
  auth_version: number;
  totp_secret_id: string | null;
  totp_pending_secret_id: string | null;
  totp_pending_expires_at: Date | null;
  totp_last_step: string | null;
}
/** Local authentication only. Never expose this object as the provider SecretStore. */
export class PostgresAccountSecurity
  extends PostgresAuthRepository
  implements AccountSecurity
{
  constructor(
    pool: Pool,
    workspaceId: WorkspaceId,
    private readonly keys: SecretKeyRing,
  ) {
    super(pool, workspaceId);
  }
  private async lock(
    client: PoolClient,
    proof: AccountProof,
  ): Promise<LockedAccount> {
    proof = accountProofSchema.parse(proof);
    const result = await client.query<LockedAccount>(
      `SELECT a.* FROM escalator_account a
      JOIN escalator_responder r ON r.workspace_id=a.workspace_id AND r.id=a.id
      WHERE a.workspace_id=$1 AND a.id=$2 AND a.auth_version=$3 AND a.enabled AND r.enabled
      FOR UPDATE OF a,r`,
      [this.workspaceId, proof.accountId, proof.authVersion],
    );
    if (!result.rows[0]) throw new AuthenticationError();
    return result.rows[0];
  }
  private async otp(
    client: PoolClient,
    account: LockedAccount,
    secretId: string,
    token: string,
  ): Promise<number> {
    const result = await client.query<{
      envelope: SecretEnvelope;
      epoch: string;
    }>(
      `SELECT envelope,
      extract(epoch FROM clock_timestamp())::text AS epoch FROM escalator_secret
      WHERE workspace_id=$1 AND id=$2 AND purpose='authentication' AND disabled_at IS NULL`,
      [this.workspaceId, secretId],
    );
    if (!result.rows[0]) throw new AuthenticationError();
    const bytes = this.keys.open(
      { workspaceId: this.workspaceId, id: secretId },
      result.rows[0].envelope,
    );
    try {
      const step = await verifyTotp(
        bytes.toString("utf8"),
        token,
        Math.floor(Number(result.rows[0].epoch)),
        account.totp_last_step === null
          ? undefined
          : Number(account.totp_last_step),
      );
      if (step === undefined) throw new AuthenticationError();
      return step;
    } finally {
      bytes.fill(0);
    }
  }
  private async factor(
    client: PoolClient,
    account: LockedAccount,
    value?: string,
  ): Promise<void> {
    if (!account.totp_secret_id) return;
    if (!value) throw new AuthenticationError();
    if (/^\d{6}$/.test(value)) {
      const step = await this.otp(
        client,
        account,
        account.totp_secret_id,
        value,
      );
      await client.query(
        "UPDATE escalator_account SET totp_last_step=$3 WHERE workspace_id=$1 AND id=$2",
        [this.workspaceId, account.id, step],
      );
    } else {
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthenticationError();
      const used = await client.query(
        `UPDATE escalator_recovery_code SET consumed_at=clock_timestamp()
        WHERE workspace_id=$1 AND account_id=$2 AND digest=$3 AND consumed_at IS NULL RETURNING digest`,
        [this.workspaceId, account.id, tokenDigest(value)],
      );
      if (used.rowCount !== 1) throw new AuthenticationError();
      await this.audit(
        client,
        "auth.recovery-code-used",
        account.id,
        account.id,
      );
    }
  }
  async authenticate(
    proof: AccountProof,
    factor?: string,
  ): Promise<AccountProof> {
    return this.transaction(async (client) => {
      const account = await this.lock(client, proof);
      await this.factor(client, account, factor);
      await this.audit(client, "auth.login", account.id, account.id);
      return { accountId: account.id, authVersion: account.auth_version };
    });
  }
  async beginTotp(proof: AccountProof): Promise<{ uri: string }> {
    return this.transaction(async (client) => {
      const account = await this.lock(client, proof);
      if (account.totp_secret_id) throw new AuthenticationError();
      const enrollment = newTotpEnrollment(account.login);
      const id = randomUUID();
      const bytes = Buffer.from(enrollment.secret, "utf8");
      try {
        const envelope = this.keys.seal(
          { workspaceId: this.workspaceId, id },
          bytes,
        );
        await client.query(
          `INSERT INTO escalator_secret(workspace_id,id,name,envelope,purpose)
          VALUES ($1,$2,'Local account TOTP',$3::jsonb,'authentication')`,
          [this.workspaceId, id, JSON.stringify(envelope)],
        );
      } finally {
        bytes.fill(0);
      }
      await this.retire(client, account.totp_pending_secret_id);
      await client.query(
        `UPDATE escalator_account SET totp_pending_secret_id=$3,
        totp_pending_expires_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,
        [this.workspaceId, account.id, id],
      );
      await this.audit(
        client,
        "auth.totp-enrollment-started",
        account.id,
        account.id,
      );
      return { uri: enrollment.uri };
    });
  }
  private async retire(client: PoolClient, id: string | null): Promise<void> {
    if (id)
      await client.query(
        `UPDATE escalator_secret SET disabled_at=clock_timestamp(),
      updated_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND purpose='authentication'`,
        [this.workspaceId, id],
      );
  }
  async enableTotp(proof: AccountProof, token: string) {
    return this.transaction(async (client) => {
      const account = await this.lock(client, proof);
      if (account.totp_secret_id || !account.totp_pending_secret_id)
        throw new AuthenticationError();
      const fresh = await client.query(
        `SELECT 1 FROM escalator_account WHERE workspace_id=$1 AND id=$2
        AND totp_pending_expires_at>clock_timestamp()`,
        [this.workspaceId, account.id],
      );
      if (fresh.rowCount !== 1) throw new AuthenticationError();
      const step = await this.otp(
        client,
        account,
        account.totp_pending_secret_id,
        token,
      );
      const codes = Array.from({ length: 10 }, () => issueToken());
      for (const code of codes)
        await client.query(
          `INSERT INTO escalator_recovery_code(workspace_id,account_id,digest)
        VALUES ($1,$2,$3)`,
          [this.workspaceId, account.id, code.digest],
        );
      await client.query(
        `UPDATE escalator_account SET totp_secret_id=totp_pending_secret_id,
        totp_pending_secret_id=NULL,totp_pending_expires_at=NULL,totp_last_step=$3,
        auth_version=auth_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [this.workspaceId, account.id, step],
      );
      await this.audit(client, "auth.totp-enabled", account.id, account.id);
      return {
        proof: { accountId: account.id, authVersion: account.auth_version + 1 },
        recoveryCodes: codes.map((code) => code.value),
      };
    });
  }
  async disableTotp(
    proof: AccountProof,
    factor: string,
  ): Promise<AccountProof> {
    return this.transaction(async (client) => {
      const account = await this.lock(client, proof);
      if (!account.totp_secret_id) throw new AuthenticationError();
      await this.factor(client, account, factor);
      await this.clearTotp(client, account);
      await client.query(
        `UPDATE escalator_account SET auth_version=auth_version+1,
        updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [this.workspaceId, account.id],
      );
      await this.audit(client, "auth.totp-disabled", account.id, account.id);
      return { accountId: account.id, authVersion: account.auth_version + 1 };
    });
  }
  private async clearTotp(
    client: PoolClient,
    account: LockedAccount,
  ): Promise<void> {
    await this.retire(client, account.totp_secret_id);
    await this.retire(client, account.totp_pending_secret_id);
    await client.query(
      `UPDATE escalator_recovery_code SET consumed_at=clock_timestamp()
      WHERE workspace_id=$1 AND account_id=$2 AND consumed_at IS NULL`,
      [this.workspaceId, account.id],
    );
    await client.query(
      `UPDATE escalator_account SET totp_secret_id=NULL,totp_pending_secret_id=NULL,
      totp_pending_expires_at=NULL,totp_last_step=NULL WHERE workspace_id=$1 AND id=$2`,
      [this.workspaceId, account.id],
    );
  }
  /** Operator CLI only: expires prior grants and invalidates sessions immediately. */
  async issueRecovery(accountId: string, digest: string): Promise<void> {
    digest = digestSchema.parse(digest);
    await this.transaction(async (client) => {
      const result = await client.query<{ auth_version: number }>(
        `UPDATE escalator_account SET auth_version=auth_version+1,
        updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND enabled RETURNING auth_version`,
        [this.workspaceId, accountId],
      );
      if (!result.rows[0]) throw new AuthenticationError();
      await client.query(
        `UPDATE escalator_auth_token SET consumed_at=clock_timestamp()
        WHERE workspace_id=$1 AND account_id=$2 AND purpose='recovery' AND consumed_at IS NULL`,
        [this.workspaceId, accountId],
      );
      await client.query(
        `INSERT INTO escalator_auth_token(workspace_id,id,digest,purpose,role,account_id,expires_at)
        VALUES ($1,$2,$3,'recovery','viewer',$4,clock_timestamp()+interval '15 minutes')`,
        [this.workspaceId, randomUUID(), digest, accountId],
      );
      await this.audit(client, "auth.operator-recovery-issued", accountId);
    });
  }
  async recover(digest: string, passwordHash: string): Promise<void> {
    digest = digestSchema.parse(digest);
    if (!passwordHash || passwordHash.length > 512)
      throw new AuthenticationError();
    await this.transaction(async (client) => {
      const token = (
        await client.query<{ id: string; account_id: string }>(
          `SELECT id,account_id FROM escalator_auth_token
        WHERE workspace_id=$1 AND digest=$2 AND purpose='recovery'`,
          [this.workspaceId, digest],
        )
      ).rows[0];
      if (!token) throw new AuthenticationError();
      const version = (
        await client.query<{ auth_version: number }>(
          `SELECT auth_version FROM escalator_account
        WHERE workspace_id=$1 AND id=$2`,
          [this.workspaceId, token.account_id],
        )
      ).rows[0];
      if (!version) throw new AuthenticationError();
      const account = await this.lock(client, {
        accountId: token.account_id,
        authVersion: version.auth_version,
      });
      const valid = await client.query(
        `UPDATE escalator_auth_token SET consumed_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
        [this.workspaceId, token.id],
      );
      if (valid.rowCount !== 1) throw new AuthenticationError();
      await this.clearTotp(client, account);
      await client.query(
        `UPDATE escalator_account SET password_hash=$3,auth_version=auth_version+1,
        updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [this.workspaceId, account.id, passwordHash],
      );
      await this.audit(client, "auth.operator-recovery-completed", account.id);
    });
  }
}
