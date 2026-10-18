import { resolve } from "node:path";
import { workConformance } from "@escalator-test/work";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
import type { WorkLease } from "@bitsentry-escalator/features/application";

workConformance(
  "standalone PostgreSQL durable work",
  async () => {
    const fixture = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    // Reserve an observer before any claim so a broken uncommitted claim cannot
    // become visible by accidentally reusing the claiming connection.
    const observer = await fixture.app.connect().catch(async (error) => {
      await fixture.dispose();
      throw error;
    });
    const reopen = () => new PostgresWorkStore(fixture.app);
    return {
      ...fixture,
      async dispose() {
        observer.release();
        await fixture.dispose();
      },
      store: reopen(),
      reopen,
      async committed(lease: WorkLease) {
        // Reserved before the claim: this cannot be its underlying connection.
        const client = observer;
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.workspace_id', $1, true)",
            [lease.workspaceId],
          );
          const relation =
            lease.queue === "job" ? "escalator_job" : "escalator_outbox";
          const visible = await client.query(
            `SELECT id FROM ${relation} WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='running'`,
            [lease.workspaceId, lease.id, lease.token],
          );
          return visible.rowCount === 1;
        } finally {
          await client.query("ROLLBACK");
        }
      },
      async expire(lease: WorkLease) {
        const client = await fixture.app.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.workspace_id', $1, true)",
            [lease.workspaceId],
          );
          const relation =
            lease.queue === "job" ? "escalator_job" : "escalator_outbox";
          await client.query(
            `UPDATE ${relation} SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE workspace_id=$1 AND id=$2 AND lease_token=$3`,
            [lease.workspaceId, lease.id, lease.token],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
  },
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both Escalator PostgreSQL test database variables",
      },
);
