import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  heartbeatConformance,
  seedHeartbeatFixture,
  heartbeatTestToken,
} from "@escalator-test/heartbeats";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { HeartbeatIntake } from "@bitsentry-escalator/features/application";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresHeartbeatRepository } from "../../src/platform/database/heartbeats.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
heartbeatConformance(
  "standalone PostgreSQL heartbeats",
  async () => {
    const f = await create();
    return {
      repository: new PostgresHeartbeatRepository(f.app),
      dispose: () => f.dispose(),
    };
  },
  options,
);
test(
  "heartbeat rows enforce workspace isolation and ping receipts reject updates",
  options,
  async () => {
    const f = await create();
    try {
      const repository = new PostgresHeartbeatRepository(f.app);
      const scope = workspaceIdSchema.parse("heartbeat_rls");
      const probe = await repository.transaction(scope, seedHeartbeatFixture);
      await new HeartbeatIntake(repository, (id) => id === scope).accept(
        probe.id,
        heartbeatTestToken,
        { version: 1, eventId: "ping", observedAt: probe.createdAt },
      );
      const client = await f.app.connect();
      try {
        for (const value of ["", "foreign", scope]) {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id',$1,true)", [
            value,
          ]);
          for (const table of [
            "escalator_heartbeat_probe",
            "escalator_heartbeat_state",
            "escalator_heartbeat_grant",
            "escalator_heartbeat_receipt",
          ]) {
            const rows = await client.query(`SELECT data FROM ${table}`);
            assert.equal(rows.rowCount, value === scope ? 1 : 0);
          }
          await client.query("COMMIT");
        }
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [
          scope,
        ]);
        await assert.rejects(
          client.query("UPDATE escalator_heartbeat_receipt SET data=data"),
          { code: "42501" },
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await f.dispose();
    }
  },
);
