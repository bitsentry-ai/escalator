import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import session from "express-session";
import {
  workspaceIdSchema,
  workspaceSchema,
} from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresSessionStore } from "../../src/platform/auth/session-store.js";
import {
  postgresFixture,
  testDatabaseConfigured,
} from "../database/postgres-fixture.js";

function cookie(maxAge: number): session.Cookie {
  const value = new session.Cookie();
  value.maxAge = maxAge;
  value.originalMaxAge = maxAge;
  return value;
}

const options = {
  skip: testDatabaseConfigured()
    ? false
    : "Not runtime-verified: no configured disposable PostgreSQL",
};
const save = (
  store: PostgresSessionStore,
  sid: string,
  data: session.SessionData,
) =>
  new Promise<void>((resolve, reject) =>
    store.set(sid, data, (error) => (error ? reject(error) : resolve())),
  );
const read = (store: PostgresSessionStore, sid: string) =>
  new Promise<session.SessionData | null | undefined>((resolve, reject) =>
    store.get(sid, (error, value) => (error ? reject(error) : resolve(value))),
  );
const destroy = (store: PostgresSessionStore, sid: string) =>
  new Promise<void>((resolve, reject) =>
    store.destroy(sid, (error) => (error ? reject(error) : resolve())),
  );

test(
  "PostgreSQL sessions isolate workspaces and reject writes after revocation",
  options,
  async () => {
    const fixture = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    try {
      const a = workspaceIdSchema.parse(randomUUID());
      const b = workspaceIdSchema.parse(randomUUID());
      for (const id of [a, b])
        await fixture.repository.transaction(id, async (tx) => {
          await tx.workspace.insert(
            workspaceSchema.parse({
              id,
              name: "Sessions",
              createdAt: tx.now,
              updatedAt: tx.now,
            }),
          );
        });
      const first = new PostgresSessionStore(fixture.app, a);
      const other = new PostgresSessionStore(fixture.app, b);
      const sid = "synthetic-opaque-session-id";
      const data = {
        cookie: cookie(60_000),
        csrf: "synthetic-csrf",
      };
      await save(first, sid, data);
      assert.ok(await read(first, sid));
      assert.equal(await read(other, sid), null);
      await destroy(first, sid);
      await assert.rejects(
        save(first, sid, data),
        /Session storage unavailable/,
      );
      assert.equal(await read(first, sid), null);
      await save(other, sid, data);
      assert.ok(await read(other, sid));
    } finally {
      await fixture.dispose();
    }
  },
);
test(
  "PostgreSQL logout wins against a concurrent session save",
  options,
  async () => {
    const fixture = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    try {
      const id = workspaceIdSchema.parse(randomUUID());
      await fixture.repository.transaction(id, async (tx) => {
        await tx.workspace.insert(
          workspaceSchema.parse({
            id,
            name: "Sessions",
            createdAt: tx.now,
            updatedAt: tx.now,
          }),
        );
      });
      const store = new PostgresSessionStore(fixture.app, id);
      const data = { cookie: cookie(60_000) };
      await save(store, "concurrent", data);
      const [revoked] = await Promise.allSettled([
        destroy(store, "concurrent"),
        save(store, "concurrent", data),
      ]);
      assert.equal(revoked.status, "fulfilled");
      assert.equal(await read(store, "concurrent"), null);
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  "PostgreSQL sessions hash IDs, cap lifetime and reject expired state",
  options,
  async () => {
    const fixture = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    try {
      const id = workspaceIdSchema.parse(randomUUID());
      await fixture.repository.transaction(id, async (tx) => {
        await tx.workspace.insert(
          workspaceSchema.parse({
            id,
            name: "Sessions",
            createdAt: tx.now,
            updatedAt: tx.now,
          }),
        );
      });
      const store = new PostgresSessionStore(fixture.app, id);
      const sid = "private-synthetic-session-id";
      const data = {
        cookie: cookie(365 * 24 * 60 * 60 * 1000),
      };
      await save(store, sid, data);
      const client = await fixture.app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          id,
        ]);
        const result = await client.query<{
          sid_digest: string;
          data: unknown;
          bounded: boolean;
        }>(
          `SELECT sid_digest,data,expires_at <= created_at + interval '8 hours' AS bounded
         FROM escalator_session WHERE workspace_id=$1`,
          [id],
        );
        assert.equal(result.rows.length, 1);
        assert.notEqual(result.rows[0].sid_digest, sid);
        assert.match(result.rows[0].sid_digest, /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(result.rows[0].data).includes(sid), false);
        assert.equal(result.rows[0].bounded, true);
        await client.query(
          "UPDATE escalator_session SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
          [id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      assert.equal(await read(store, sid), null);
      await assert.rejects(
        save(store, sid, data),
        /Session storage unavailable/,
      );
    } finally {
      await fixture.dispose();
    }
  },
);
