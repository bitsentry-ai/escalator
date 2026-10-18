import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { generate } from "otplib";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { PostgresAccountSecurity } from "../../src/platform/auth/account-security.repository.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { issueToken } from "../../src/platform/auth/credentials.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import {
  postgresFixture,
  testDatabaseConfigured,
} from "../database/postgres-fixture.js";
const options = {
  skip: testDatabaseConfigured()
    ? false
    : "Not runtime-verified: no configured disposable PostgreSQL",
};
async function prepare() {
  const f = await postgresFixture(await readMigrations(resolve("migrations")));
  const scope = workspaceIdSchema.parse(randomUUID());
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 7).toString("base64") },
  });
  const auth = new PostgresAccountSecurity(f.app, scope, keys);
  try {
    const token = issueToken();
    await auth.bootstrap("Fixture", token.digest, new Date(Date.now() + 60000));
    const id = await auth.register({
      tokenDigest: token.digest,
      login: "owner",
      passwordHash: "fixture-hash",
      displayName: "Owner",
      timeZone: "UTC",
    });
    return { ...f, auth, scope, proof: { accountId: id, authVersion: 1 } };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
async function otp(uri: string) {
  const secret = new URL(uri).searchParams.get("secret")!;
  return generate({
    secret,
    algorithm: "sha1",
    digits: 6,
    period: 30,
    strategy: "totp",
  });
}
async function enroll(f: Awaited<ReturnType<typeof prepare>>) {
  const enrollment = await f.auth.beginTotp(f.proof);
  const token = await otp(enrollment.uri);
  return { enrollment, token, ...(await f.auth.enableTotp(f.proof, token)) };
}
test(
  "PostgreSQL MFA activation revokes old versions and rejects replayed enrollment codes",
  options,
  async () => {
    const f = await prepare();
    try {
      const enabled = await enroll(f);
      assert.equal(enabled.recoveryCodes.length, 10);
      await assert.rejects(f.auth.authenticate(f.proof));
      await assert.rejects(f.auth.authenticate(enabled.proof));
      await assert.rejects(f.auth.authenticate(enabled.proof, enabled.token));
      const attempts = await Promise.allSettled([
        f.auth.authenticate(enabled.proof, enabled.recoveryCodes[0]),
        f.auth.authenticate(enabled.proof, enabled.recoveryCodes[0]),
      ]);
      assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
      const audit = await f.repository.transaction(f.scope, (tx) =>
        tx.audit.list({ limit: 30 }),
      );
      assert.equal(
        JSON.stringify(audit).includes(enabled.recoveryCodes[0]),
        false,
      );
      assert.equal(
        JSON.stringify(audit).includes(
          new URL(enabled.enrollment.uri).searchParams.get("secret")!,
        ),
        false,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL re-enrollment replaces pending secrets and expired enrollment fails",
  options,
  async () => {
    const f = await prepare();
    try {
      const first = await f.auth.beginTotp(f.proof);
      const second = await f.auth.beginTotp(f.proof);
      assert.notEqual(first.uri, second.uri);
      const client = await f.app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [
          f.scope,
        ]);
        const rows = await client.query(
          "SELECT envelope,disabled_at FROM escalator_secret WHERE workspace_id=$1 AND purpose='authentication'",
          [f.scope],
        );
        assert.equal(rows.rows.length, 2);
        assert.equal(rows.rows.filter((r) => r.disabled_at !== null).length, 1);
        assert.equal(
          JSON.stringify(rows.rows).includes(
            new URL(second.uri).searchParams.get("secret")!,
          ),
          false,
        );
        await client.query(
          "UPDATE escalator_account SET totp_pending_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
          [f.scope],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await assert.rejects(f.auth.enableTotp(f.proof, await otp(second.uri)));
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL disabling MFA consumes factors and invalidates remaining recovery codes",
  options,
  async () => {
    const f = await prepare();
    try {
      const enabled = await enroll(f);
      const disabled = await f.auth.disableTotp(
        enabled.proof,
        enabled.recoveryCodes[0],
      );
      await assert.rejects(
        f.auth.authenticate(enabled.proof, enabled.recoveryCodes[1]),
      );
      assert.deepEqual(await f.auth.authenticate(disabled), disabled);
      const next = await f.auth.beginTotp(disabled);
      const again = await f.auth.enableTotp(disabled, await otp(next.uri));
      await assert.rejects(
        f.auth.authenticate(again.proof, enabled.recoveryCodes[1]),
      );
      assert.deepEqual(
        await f.auth.authenticate(again.proof, again.recoveryCodes[0]),
        again.proof,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL operator recovery is one-use, rotates credentials and revokes sessions and MFA",
  options,
  async () => {
    const f = await prepare();
    try {
      const enabled = await enroll(f);
      const old = issueToken();
      const current = issueToken();
      await f.auth.issueRecovery(f.proof.accountId, old.digest);
      await assert.rejects(
        f.auth.authenticate(enabled.proof, enabled.recoveryCodes[0]),
      );
      await f.auth.issueRecovery(f.proof.accountId, current.digest);
      await assert.rejects(f.auth.recover(old.digest, "new-hash"));
      const attempts = await Promise.allSettled([
        f.auth.recover(current.digest, "new-hash"),
        f.auth.recover(current.digest, "new-hash"),
      ]);
      assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
      const account = await f.auth.findById(f.proof.accountId);
      assert.ok(account);
      assert.equal(account.passwordHash, "new-hash");
      assert.equal(account.totpSecretId, null);
      assert.ok(account.authVersion > enabled.proof.authVersion);
      assert.deepEqual(
        await f.auth.authenticate({
          accountId: account.id,
          authVersion: account.authVersion,
        }),
        { accountId: account.id, authVersion: account.authVersion },
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "PostgreSQL expired operator grants cannot replace credentials",
  options,
  async () => {
    const f = await prepare();
    try {
      const grant = issueToken();
      await f.auth.issueRecovery(f.proof.accountId, grant.digest);
      const client = await f.app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [
          f.scope,
        ]);
        await client.query(
          "UPDATE escalator_auth_token SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND digest=$2",
          [f.scope, grant.digest],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await assert.rejects(f.auth.recover(grant.digest, "replacement-hash"));
      assert.equal(
        (await f.auth.findById(f.proof.accountId))?.passwordHash,
        "fixture-hash",
      );
    } finally {
      await f.dispose();
    }
  },
);
