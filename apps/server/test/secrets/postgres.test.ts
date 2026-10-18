import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  workspaceSchema,
  responderIdSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { PostgresSecretReader } from "../../src/platform/secrets/postgres-secret.reader.js";
import {
  PostgresSecretWriter,
  SecretRotationOperator,
} from "../../src/platform/secrets/postgres-secret.writer.js";
import { EncryptedSecretStore } from "../../src/platform/secrets/encrypted-secret.store.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import {
  postgresFixture,
  testDatabaseConfigured,
} from "../database/postgres-fixture.js";

const options = {
  skip: testDatabaseConfigured()
    ? false
    : "Not runtime-verified: no configured disposable PostgreSQL",
};
const old = Buffer.alloc(32, 1).toString("base64");
const next = Buffer.alloc(32, 2).toString("base64");
for (const queue of ["job", "outbox"] as const) {
  test(
    `PostgreSQL secrets: ${queue} authorization, rotation, revocation and scope`,
    options,
    async () => {
      const fixture = await postgresFixture(
        await readMigrations(resolve("migrations")),
      );
      try {
        const workspaceId = workspaceIdSchema.parse(randomUUID());
        const actor: Actor = {
          workspaceId,
          responderId: responderIdSchema.parse("admin"),
          role: "administrator",
        };
        await fixture.repository.transaction(workspaceId, async (tx) => {
          await tx.workspace.insert(
            workspaceSchema.parse({
              id: workspaceId,
              name: "Secrets",
              createdAt: tx.now,
              updatedAt: tx.now,
            }),
          );
        });
        const keys = SecretKeyRing.parse({
          version: 1,
          activeKeyId: "old",
          keys: { old },
        });
        const writer = new PostgresSecretWriter(fixture.app, keys);
        const secret = await writer.create(
          actor,
          "fixture",
          Buffer.from("private-fixture"),
        );
        const active = await writer.create(
          actor,
          "active",
          Buffer.from("active-value"),
        );
        const authentication = await writer.create(
          actor,
          "totp-fixture",
          Buffer.from("authentication-fixture"),
        );
        const connection = await fixture.app.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id', $1, true)",
            [workspaceId],
          );
          await connection.query(
            "UPDATE escalator_secret SET purpose='authentication' WHERE workspace_id=$1 AND id=$2",
            [workspaceId, authentication.id],
          );
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
        await assert.rejects(
          writer.create(
            { ...actor, role: "viewer" },
            "denied",
            Buffer.from("value"),
          ),
          { code: "secret_unavailable" },
        );
        await fixture.repository.transaction(workspaceId, (tx) =>
          tx.work.enqueue(queue, {
            id: "send",
            kind: "send",
            idempotencyKey: "send",
            dueAt: tx.now,
            payload: { secretIds: [secret.id, active.id, authentication.id] },
          }),
        );
        const work = new PostgresWorkStore(fixture.app);
        const lease = await work.claim({
          workspaceId,
          queue,
          kinds: ["send"],
          token: randomUUID(),
          leaseMs: 30_000,
        });
        assert.ok(lease);
        const request = {
          workspaceId,
          queue,
          secretId: secret.id,
          workId: lease.id,
          claimToken: lease.token,
          signal: new AbortController().signal,
        };
        const reader = new PostgresSecretReader(fixture.app);
        const store = new EncryptedSecretStore(keys, reader);
        assert.equal(
          await store.withSecret(request, async (bytes) =>
            Buffer.from(bytes).toString(),
          ),
          "private-fixture",
        );
        await assert.rejects(
          store.withSecret(
            { ...request, secretId: authentication.id },
            async () => true,
          ),
          { code: "secret_unavailable" },
        );
        const persisted = await reader.load(request);
        assert.ok(persisted);
        assert.equal(
          JSON.stringify(persisted.envelope).includes("private-fixture"),
          false,
        );
        await assert.rejects(
          store.withSecret(
            { ...request, workspaceId: workspaceIdSchema.parse("other") },
            async () => true,
          ),
          { code: "secret_unavailable" },
        );
        await assert.rejects(
          store.withSecret(
            { ...request, claimToken: "wrong" },
            async () => true,
          ),
          { code: "secret_unavailable" },
        );
        const rotating = SecretKeyRing.parse({
          version: 1,
          activeKeyId: "next",
          keys: { old, next },
        });
        const result = await new PostgresSecretWriter(
          fixture.app,
          rotating,
        ).rotateBatch(new SecretRotationOperator(workspaceId), undefined);
        assert.equal(result.rotated, 3);
        assert.equal(result.remaining, 0);
        const newOnly = new EncryptedSecretStore(
          SecretKeyRing.parse({
            version: 1,
            activeKeyId: "next",
            keys: { next },
          }),
          reader,
        );
        assert.equal(
          await newOnly.withSecret(request, async (bytes) =>
            Buffer.from(bytes).toString(),
          ),
          "private-fixture",
        );
        assert.equal(await writer.disable(actor, secret.id), true);
        const audit = await fixture.repository.transaction(workspaceId, (tx) =>
          tx.audit.list({ limit: 20 }),
        );
        assert.equal(
          audit.items.filter((event) => event.action === "secret.created")
            .length,
          3,
        );
        assert.equal(
          audit.items.filter((event) => event.action === "secret.rotated")
            .length,
          3,
        );
        assert.equal(
          audit.items.filter((event) => event.action === "secret.disabled")
            .length,
          1,
        );
        assert.equal(
          JSON.stringify(audit.items).includes("private-fixture"),
          false,
        );
        assert.equal(
          JSON.stringify(audit.items).includes("active-value"),
          false,
        );
        await assert.rejects(
          newOnly.withSecret(request, async () => true),
          { code: "secret_unavailable" },
        );
        assert.equal(
          await newOnly.withSecret(
            { ...request, secretId: active.id },
            async (bytes) => Buffer.from(bytes).toString(),
          ),
          "active-value",
        );
        assert.equal(
          await work.settle(lease, { state: "completed", outcome: "accepted" }),
          true,
        );
        await assert.rejects(
          newOnly.withSecret(
            { ...request, secretId: active.id },
            async () => true,
          ),
          { code: "secret_unavailable" },
        );
      } finally {
        await fixture.dispose();
      }
    },
  );
}
