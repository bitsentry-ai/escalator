import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  deploymentConformance,
  seedDeploymentFixture,
  fixtureDeployment,
  deployFixtureHash,
} from "@escalator-test/deployments";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresDeploymentRepository } from "../../src/platform/database/deployments.repository.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
async function create() {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  return {
    database,
    repository: new PostgresDeploymentRepository(database.app),
    configuration: new PostgresConfigurationRepository(database.app),
    work: new PostgresWorkStore(database.app),
    dispose: () => database.dispose(),
  };
}
deploymentConformance("standalone PostgreSQL deployments", create, options);

test(
  "deployment RLS scopes every populated table and hash lookup cannot write or escape its transaction",
  options,
  async () => {
    const fixture = await create();
    const a = workspaceIdSchema.parse("deploy_rls_a"),
      b = workspaceIdSchema.parse("deploy_rls_b");
    try {
      for (const scope of [a, b]) {
        await seedDeploymentFixture(fixture, scope);
        await fixture.repository.transaction(scope, async (tx) => {
          const entry = await fixtureDeployment(tx);
          await tx.deployments.insert(entry);
          await tx.receipts.insert({
            workspaceId: scope,
            targetId: "target",
            key: "request",
            action: "start",
            tokenId: "token",
            requestHash: "a".repeat(64),
            recordedAt: await tx.currentTime(),
            result: {
              state: "accepted",
              deploymentId: entry.deployment.id,
              revision: 1,
              status: "STARTED",
            },
          });
        });
      }
      const connection = await fixture.database.app.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id','',true),set_config('app.deployment_token_hash','',true)",
        );
        const tables = [
          "escalator_deploy_target",
          "escalator_deploy_grant",
          "escalator_deployment",
          "escalator_deploy_receipt",
        ];
        for (const table of tables)
          assert.equal(
            (await connection.query(`SELECT workspace_id FROM ${table}`))
              .rowCount,
            0,
          );
        await connection.query(
          "SELECT set_config('app.deployment_token_hash',$1,true)",
          [deployFixtureHash(a)],
        );
        assert.deepEqual(
          (
            await connection.query(
              "SELECT workspace_id,target_id,id FROM escalator_deploy_grant",
            )
          ).rows,
          [{ workspace_id: a, target_id: "target", id: "token" }],
        );
        assert.equal(
          (
            await connection.query(
              "UPDATE escalator_deploy_grant SET data=data WHERE token_hash=$1",
              [deployFixtureHash(a)],
            )
          ).rowCount,
          0,
        );
        for (const table of tables.filter(
          (value) => value !== "escalator_deploy_grant",
        ))
          assert.equal(
            (await connection.query(`SELECT workspace_id FROM ${table}`))
              .rowCount,
            0,
          );
        await connection.query(
          "SELECT set_config('app.deployment_token_hash','',true),set_config('app.workspace_id',$1,true)",
          [a],
        );
        for (const table of tables)
          assert.deepEqual(
            (await connection.query(`SELECT workspace_id FROM ${table}`)).rows,
            [{ workspace_id: a }],
          );
        const stored = (
          await connection.query("SELECT data,policy FROM escalator_deployment")
        ).rows[0];
        assert.equal("workspaceId" in stored.data, false);
        assert.equal("workspaceId" in stored.policy, false);
        await connection.query("COMMIT");
        assert.equal(
          (
            await connection.query(
              "SELECT workspace_id FROM escalator_deploy_grant",
            )
          ).rowCount,
          0,
        );
        // Hold this connection so the pool query below reuses the lookup's returned connection.
        assert.deepEqual(
          await fixture.repository.findTokenContext(deployFixtureHash(b)),
          { workspaceId: b, targetId: "target", id: "token" },
        );
        assert.equal(
          (
            await fixture.database.app.query(
              "SELECT workspace_id FROM escalator_deploy_grant",
            )
          ).rowCount,
          0,
        );
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  "deployment target locking serializes concurrent starts before a row exists",
  options,
  async () => {
    const fixture = await create();
    const scope = workspaceIdSchema.parse("deploy_concurrent");
    try {
      await seedDeploymentFixture(fixture, scope);
      const results = await Promise.all(
        ["first", "second"].map((id) =>
          fixture.repository.transaction(scope, async (tx) => {
            const existing = await tx.deployments.find(
              "target",
              "fixture",
              "same-external",
            );
            if (existing) return existing.deployment.id;
            const entry = await fixtureDeployment(tx, id);
            entry.deployment.externalId = "same-external";
            await tx.deployments.insert(entry);
            return entry.deployment.id;
          }),
        ),
      );
      assert.equal(results[0], results[1]);
      await fixture.repository.transaction(scope, async (tx) =>
        assert.equal(
          (await tx.deployments.list("target", { limit: 10 })).items.length,
          1,
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  "deployment foreign keys reject another workspace's grant and receipt permissions forbid rewriting history",
  options,
  async () => {
    const fixture = await create();
    const a = workspaceIdSchema.parse("deploy_fk_a"),
      b = workspaceIdSchema.parse("deploy_fk_b");
    try {
      for (const scope of [a, b]) await seedDeploymentFixture(fixture, scope);
      await fixture.repository.transaction(a, async (tx) => {
        const entry = await fixtureDeployment(tx);
        await tx.deployments.insert(entry);
        await tx.receipts.insert({
          workspaceId: a,
          targetId: "target",
          key: "request",
          action: "start",
          tokenId: "token",
          requestHash: "a".repeat(64),
          recordedAt: await tx.currentTime(),
          result: {
            state: "accepted",
            deploymentId: entry.deployment.id,
            revision: 1,
            status: "STARTED",
          },
        });
      });
      await fixture.repository.transaction(b, async (tx) => {
        const grant = (await tx.tokens.get("target", deployFixtureHash(b)))!;
        await tx.tokens.insert({
          ...grant,
          id: "foreign-only",
          tokenHash: "f".repeat(64),
          createdAt: tx.now,
        });
      });
      const connection = await fixture.database.app.connect();
      try {
        for (const [sql, code] of [
          [
            "UPDATE escalator_deployment SET token_id='foreign-only',data=jsonb_set(data,'{tokenId}',to_jsonb('foreign-only'::text)) WHERE id='deployment'",
            "23503",
          ],
          [
            "UPDATE escalator_deployment SET policy=policy || '{\"workspaceId\":\"forged\"}'::jsonb WHERE id='deployment'",
            "23514",
          ],
          [
            "UPDATE escalator_deploy_receipt SET data=data WHERE idempotency_key='request'",
            "42501",
          ],
        ] as const) {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [a],
          );
          await assert.rejects(
            connection.query(sql),
            (error) => (error as { code?: string }).code === code,
          );
          await connection.query("ROLLBACK");
        }
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      await fixture.repository.transaction(a, async (tx) =>
        assert.equal(
          (await tx.deployments.get("target", "deployment"))!.deployment
            .tokenId,
          "token",
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
);
