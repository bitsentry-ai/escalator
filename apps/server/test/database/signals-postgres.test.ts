import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  signalConformance,
  seedSignalFixture,
  fixtureSignal,
  fixtureToken,
} from "@escalator-test/signals";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import {
  SignalIntake,
  signalTokenDigest,
} from "@bitsentry-escalator/features/application";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresSignalRepository } from "../../src/platform/database/signals.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
signalConformance(
  "standalone PostgreSQL signals",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresSignalRepository(fixture.app),
      work: new PostgresWorkStore(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);

test(
  "signal RLS denies unscoped access and limits authentication lookup to one hash",
  options,
  async () => {
    const fixture = await create();
    try {
      const repo = new PostgresSignalRepository(fixture.app);
      const a = workspaceIdSchema.parse("signal_rls_a");
      const b = workspaceIdSchema.parse("signal_rls_b");
      for (const [scope, hash] of [
        [a, "a".repeat(64)],
        [b, "b".repeat(64)],
      ] as const) {
        await repo.transaction(scope, async (tx) => {
          await seedSignalFixture(tx);
          await tx.tokens.insert(fixtureToken(tx, hash));
          await tx.signals.insert(fixtureSignal(tx));
        });
      }
      const connection = await fixture.app.connect();
      try {
        await connection.query("BEGIN");
        for (const table of ["source", "token", "event"]) {
          const result = await connection.query(
            `SELECT id FROM escalator_signal_${table}`,
          );
          assert.equal(result.rowCount, 0);
        }
        await connection.query(
          "SELECT set_config('app.signal_token_hash',$1,true)",
          ["a".repeat(64)],
        );
        const token = await connection.query(
          "SELECT workspace_id FROM escalator_signal_token",
        );
        assert.deepEqual(token.rows, [{ workspace_id: a }]);
        for (const table of ["source", "event"]) {
          assert.equal(
            (await connection.query(`SELECT id FROM escalator_signal_${table}`))
              .rowCount,
            0,
          );
        }
        assert.equal(
          (
            await connection.query(
              "UPDATE escalator_signal_token SET data=data WHERE token_hash=$1",
              ["a".repeat(64)],
            )
          ).rowCount,
          0,
        );
        await connection.query("COMMIT");
        assert.equal(
          (await connection.query("SELECT id FROM escalator_signal_token"))
            .rowCount,
          0,
        );
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      assert.deepEqual(await repo.findTokenContext("b".repeat(64)), {
        workspaceId: b,
        sourceId: "source",
        id: "token",
      });
      assert.equal(await repo.findTokenContext("c".repeat(64)), undefined);
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  "concurrent PostgreSQL ingress persists one event, processing job and audit",
  options,
  async () => {
    const fixture = await create();
    try {
      const repo = new PostgresSignalRepository(fixture.app);
      const scope = workspaceIdSchema.parse("signal_duplicate");
      const token = `esi_${randomBytes(32).toString("base64url")}`;
      await repo.transaction(scope, async (tx) => {
        await seedSignalFixture(tx);
        await tx.tokens.insert(fixtureToken(tx, signalTokenDigest(token)!));
      });
      const input = {
        version: 1,
        eventId: "event",
        fingerprint: "checkout",
        status: "active",
        severity: "critical",
        title: "Checkout failed",
        observedAt: "2026-09-20T00:00:00.000Z",
        evidence: { summary: "HTTP 500", attributes: [] },
      };
      const intake = new SignalIntake(repo);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => intake.accept("source", token, input)),
      );
      assert.equal(
        results.filter((result) => result.state === "accepted").length,
        1,
      );
      assert.equal(new Set(results.map((result) => result.signalId)).size, 1);
      await repo.transaction(scope, async (tx) => {
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 1);
        assert.equal(
          (await tx.signals.get(results[0].signalId))?.status,
          "active",
        );
        await tx.tokens.revoke("token");
      });
      await assert.rejects(
        intake.accept("source", token, { ...input, eventId: "after-revoke" }),
        /invalid_token/,
      );
      const work = new PostgresWorkStore(fixture.app);
      const request = {
        workspaceId: scope,
        queue: "job" as const,
        kinds: ["signal.process"],
        token: "claim",
        leaseMs: 60000,
      };
      assert.deepEqual((await work.claim(request))?.payload, {
        signalId: results[0].signalId,
      });
      assert.equal(
        await work.claim({ ...request, token: "second" }),
        undefined,
      );
    } finally {
      await fixture.dispose();
    }
  },
);
