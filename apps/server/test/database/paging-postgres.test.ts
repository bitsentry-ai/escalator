import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pagingConformance, seedPagingFixture } from "@escalator-test/paging";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresPagingRepository } from "../../src/platform/database/paging.repository.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";

const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure ESCALATOR_TEST_DATABASE_URL and ESCALATOR_TEST_MIGRATION_DATABASE_URL on a disposable database",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
pagingConformance(
  "standalone PostgreSQL paging",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresPagingRepository(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);

test(
  "paging RLS hides populated tables without scope and rejects foreign writes",
  options,
  async () => {
    const fixture = await create();
    try {
      const scope = workspaceIdSchema.parse("paging_rls");
      const repository = new PostgresPagingRepository(fixture.app);
      await repository.transaction(scope, seedPagingFixture);
      for (const table of [
        "escalator_incident",
        "escalator_page",
        "escalator_page_step",
        "escalator_delivery",
        "escalator_delivery_attempt",
        "escalator_ack_grant",
      ])
        assert.deepEqual(
          (await fixture.app.query(`SELECT id FROM ${table}`)).rows,
          [],
        );
      const original = await repository.transaction(scope, (tx) =>
        tx.incidents.get("incident"),
      );
      const data = Object.fromEntries(
        Object.entries({ ...original!, id: "denied" }).filter(
          ([key]) => key !== "workspaceId",
        ),
      );
      const connection = await fixture.app.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id', 'foreign', true)",
        );
        assert.deepEqual(
          (
            await connection.query(
              "SELECT id FROM escalator_page WHERE workspace_id=$1",
              [scope],
            )
          ).rows,
          [],
        );
        await assert.rejects(
          connection.query(
            "INSERT INTO escalator_incident (workspace_id,id,data,service_id,environment_id) VALUES ($1,'denied',$2,'api','prod')",
            [scope, JSON.stringify(data)],
          ),
          { code: "42501" },
        );
      } finally {
        try {
          await connection.query("ROLLBACK");
        } finally {
          connection.release();
        }
      }
    } finally {
      await fixture.dispose();
    }
  },
);
