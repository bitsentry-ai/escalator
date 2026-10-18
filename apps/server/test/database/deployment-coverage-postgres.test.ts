import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  coverageConformance,
  seedCoverageFixture,
  fixtureCoverage,
} from "@escalator-test/coverage";
import {
  workspaceIdSchema,
  responderIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import { PostgresCoverageRepository } from "../../src/platform/database/deployment-coverage.repository.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { PostgresSecretWriter } from "../../src/platform/secrets/postgres-secret.writer.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
async function create(coverageMutationPrivileges = false) {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
    { coverageMutationPrivileges },
  );
  const writer = new PostgresSecretWriter(
    database.app,
    SecretKeyRing.parse({
      version: 1,
      activeKeyId: "fixture",
      keys: { fixture: Buffer.alloc(32, 1).toString("base64") },
    }),
  );
  return {
    database,
    repository: new PostgresCoverageRepository(database.app),
    configuration: new PostgresConfigurationRepository(database.app),
    work: new PostgresWorkStore(database.app),
    providerSecret: async (scope: WorkspaceId) =>
      (
        await writer.create(
          {
            workspaceId: scope,
            responderId: responderIdSchema.parse("primary"),
            role: "administrator",
          },
          "provider",
          Buffer.from("fixture"),
        )
      ).id,
    dispose: () => database.dispose(),
  };
}
coverageConformance(
  "standalone PostgreSQL deployment coverage",
  () => create(),
  options,
);
test(
  "coverage decisions enforce RLS and append-only policies even with update/delete grants",
  options,
  async () => {
    const fixture = await create(true);
    const a = workspaceIdSchema.parse("coverage_rls_a"),
      b = workspaceIdSchema.parse("coverage_rls_b");
    try {
      for (const scope of [a, b]) {
        await seedCoverageFixture(fixture, scope);
        await fixture.repository.transaction(scope, async (tx) =>
          tx.coverage.insert(await fixtureCoverage(tx)),
        );
      }
      assert.equal(
        (
          await fixture.database.app.query(
            "SELECT id FROM escalator_coverage_decision",
          )
        ).rowCount,
        0,
      );
      const connection = await fixture.database.app.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id',$1,true)",
          [a],
        );
        assert.deepEqual(
          (
            await connection.query(
              "SELECT workspace_id FROM escalator_coverage_decision",
            )
          ).rows,
          [{ workspace_id: a }],
        );
        assert.equal(
          (
            await connection.query(
              "UPDATE escalator_coverage_decision SET request_hash=$1",
              ["b".repeat(64)],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await connection.query("DELETE FROM escalator_coverage_decision"))
            .rowCount,
          0,
        );
        await connection.query("SAVEPOINT scope_probe");
        await assert.rejects(
          connection.query(
            `INSERT INTO escalator_coverage_decision(workspace_id,id,target_id,service_id,environment_id,policy_id,mapped_deployer_id,override_actor_id,idempotency_key,request_hash,evaluated_at,expires_at,data)
        SELECT $1,'foreign',target_id,service_id,environment_id,policy_id,mapped_deployer_id,override_actor_id,'foreign-command',request_hash,evaluated_at,expires_at,data || jsonb_build_object('id','foreign') FROM escalator_coverage_decision`,
            [b],
          ),
          (error: unknown) => (error as { code?: string }).code === "42501",
        );
        await connection.query("ROLLBACK TO SAVEPOINT scope_probe");
        await connection.query("COMMIT");
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      await fixture.repository.transaction(a, async (tx) =>
        assert.equal(
          (await tx.coverage.get("target", "decision"))!.requestHash,
          "a".repeat(64),
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
);
