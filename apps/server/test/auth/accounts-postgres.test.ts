import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresAuthRepository } from "../../src/platform/auth/auth.repository.js";
import {
  postgresFixture,
  testDatabaseConfigured,
} from "../database/postgres-fixture.js";
const options = {
  skip: testDatabaseConfigured()
    ? false
    : "Not runtime-verified: no configured disposable PostgreSQL",
};
const registration = (tokenDigest: string, login: string) => ({
  tokenDigest,
  login,
  passwordHash: "fixture-password-hash",
  displayName: login,
  timeZone: "UTC",
});
async function prepare() {
  const fixture = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  const scope = workspaceIdSchema.parse(randomUUID());
  const repository = new PostgresAuthRepository(fixture.app, scope);
  try {
    await repository.bootstrap(
      "Auth fixture",
      "a".repeat(64),
      new Date(Date.now() + 60_000),
    );
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
  return { ...fixture, auth: repository, scope };
}
test(
  "PostgreSQL bootstrap is single-use under concurrent registration",
  options,
  async () => {
    const f = await prepare();
    try {
      const results = await Promise.allSettled([
        f.auth.register(registration("a".repeat(64), "owner-a")),
        f.auth.register(registration("a".repeat(64), "owner-b")),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      const winner = results.find((result) => result.status === "fulfilled");
      assert.ok(winner && winner.status === "fulfilled");
      assert.equal(
        (await f.auth.findById(winner.value))?.role,
        "administrator",
      );
      await assert.rejects(
        f.auth.bootstrap(
          "Again",
          "b".repeat(64),
          new Date(Date.now() + 60_000),
        ),
        { code: "authentication_failed" },
      );
      const audit = await f.repository.transaction(f.scope, (tx) =>
        tx.audit.list({ limit: 20 }),
      );
      assert.equal(
        audit.items.filter((event) => event.action === "account.created")
          .length,
        1,
      );
      assert.equal(
        JSON.stringify(audit).includes("fixture-password-hash"),
        false,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL registration rollback preserves invitation and prevents role substitution",
  options,
  async () => {
    const f = await prepare();
    try {
      const owner = await f.auth.register(
        registration("a".repeat(64), "owner"),
      );
      await f.auth.invite(
        { accountId: owner, authVersion: 1 },
        "b".repeat(64),
        "viewer",
        new Date(Date.now() + 60_000),
      );
      await assert.rejects(
        f.auth.register(registration("b".repeat(64), "owner")),
      );
      const input = {
        ...registration("b".repeat(64), "reader"),
        role: "administrator",
      };
      await assert.rejects(f.auth.register(input));
      const reader = await f.auth.register(
        registration("b".repeat(64), "reader"),
      );
      assert.equal((await f.auth.findById(reader))?.role, "viewer");
      await assert.rejects(
        f.auth.invite(
          { accountId: reader, authVersion: 1 },
          "c".repeat(64),
          "administrator",
          new Date(Date.now() + 60_000),
        ),
        { code: "authentication_failed" },
      );
      await assert.rejects(
        f.auth.invite(
          { accountId: owner, authVersion: 999 },
          "c".repeat(64),
          "administrator",
          new Date(Date.now() + 60_000),
        ),
        { code: "authentication_failed" },
      );
      const responders = await f.repository.transaction(f.scope, (tx) =>
        tx.responders.list({ limit: 20 }),
      );
      assert.equal(responders.items.length, 2);
      const other = new PostgresAuthRepository(
        f.app,
        workspaceIdSchema.parse(randomUUID()),
      );
      assert.equal(await other.findById(owner), undefined);
      assert.equal(await other.findByLogin("owner"), undefined);
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL authentication rate bucket enforces its limit atomically",
  options,
  async () => {
    const f = await prepare();
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          f.auth.takeRateSlot("d".repeat(64), 3, 60),
        ),
      );
      assert.equal(outcomes.filter(Boolean).length, 3);
      assert.equal(outcomes.filter((value) => !value).length, 5);
      await assert.rejects(
        f.auth.takeRateSlot("e".repeat(64), 0, 60),
        /rate policy/,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "PostgreSQL bootstrap rejects expired and replaced credentials",
  options,
  async () => {
    const f = await prepare();
    try {
      await f.auth.bootstrap("Expired", "a".repeat(64), new Date(0));
      await assert.rejects(
        f.auth.register(registration("a".repeat(64), "owner")),
        { code: "authentication_failed" },
      );
      await f.auth.bootstrap(
        "Reissued",
        "b".repeat(64),
        new Date(Date.now() + 60_000),
      );
      await assert.rejects(
        f.auth.register(registration("a".repeat(64), "owner")),
        { code: "authentication_failed" },
      );
      const owner = await f.auth.register(
        registration("b".repeat(64), "owner"),
      );
      assert.equal((await f.auth.findById(owner))?.role, "administrator");
    } finally {
      await f.dispose();
    }
  },
);
