import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  workspaceIdSchema,
  workspaceSchema,
} from "@bitsentry-escalator/features/contracts";
import { foundationConformance } from "@escalator-test/foundation";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";

const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both ESCALATOR_TEST_DATABASE_URL and ESCALATOR_TEST_MIGRATION_DATABASE_URL on a disposable database",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
foundationConformance("standalone PostgreSQL", create, options);
test(
  "PostgreSQL RLS fails closed without a transaction scope",
  options,
  async () => {
    const fixture = await create();
    try {
      const scope = workspaceIdSchema.parse("rls_fixture");
      await fixture.repository.transaction(scope, async (tx) => {
        await tx.workspace.insert(
          workspaceSchema.parse({
            id: scope,
            name: "Scoped",
            createdAt: tx.now,
            updatedAt: tx.now,
          }),
        );
      });
      const visible = await fixture.app.query(
        "SELECT id FROM escalator_workspace",
      );
      assert.deepEqual(visible.rows, []);
      await assert.rejects(
        fixture.app.query(
          "INSERT INTO escalator_workspace (id,name,created_at,updated_at) VALUES ('unscoped','Denied',now(),now())",
        ),
        { code: "42501" },
      );
      const client = await fixture.app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          "different_workspace",
        ]);
        assert.deepEqual(
          (
            await client.query(
              "SELECT id FROM escalator_workspace WHERE id=$1",
              [scope],
            )
          ).rows,
          [],
        );
        await assert.rejects(
          client.query(
            "INSERT INTO escalator_service (workspace_id,id,name,key,owning_team,enabled,created_at,updated_at) VALUES ($1,'foreign','Denied','denied','Platform',true,now(),now())",
            [scope],
          ),
          { code: "42501" },
        );
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    } finally {
      await fixture.dispose();
    }
  },
);
