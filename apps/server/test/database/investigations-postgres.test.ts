import {
  investigationReportConformance,
  type InvestigationReportFixture,
} from "@escalator-test/investigation-reports";
import { PostgresInvestigationReportRepository } from "../../src/platform/database/postgres-investigation-report.repository.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  workspaceIdSchema,
  operationalIncidentSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import { captureInvestigation } from "@bitsentry-escalator/features/investigation";
import {
  investigationPersistenceConformance,
  type InvestigationPersistenceFixture,
} from "@escalator-test/investigations";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import { seedPagingFixture } from "@escalator-test/paging";
import { PostgresPagingRepository } from "../../src/platform/database/paging.repository.js";
import {
  PostgresInvestigationRepository,
  type InvestigationDatabasePolicy,
} from "../../src/platform/database/postgres-investigation.repository.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
async function create(): Promise<
  InvestigationReportFixture & { expireDuringAuthorization(): void }
> {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  const scope = workspaceIdSchema.parse("investigation_" + randomUUID());
  const other = workspaceIdSchema.parse("investigation_" + randomUUID());
  let observer: PoolClient | undefined;
  try {
    const paging = new PostgresPagingRepository(database.app);
    for (const workspaceId of [scope, other])
      await paging.transaction(workspaceId, async (tx) => {
        await seedPagingFixture(tx);
        await tx.incidents.insert(
          operationalIncidentSchema.parse({
            id: "incident_a",
            workspaceId,
            serviceId: "api",
            environmentId: "prod",
            title: "Outage",
            severity: "critical",
            openedAt: tx.now,
            resolvedAt: null,
          }),
        );
      });
    const sample = investigationFixture();
    sample.claim.scope.workspaceId = scope;
    sample.result.report.scope.workspaceId = scope;
    for (const item of sample.result.evidence) item.scope.workspaceId = scope;
    const intent = {
      id: sample.claim.id,
      scope: sample.claim.scope,
      idempotencyKey: "first-page",
      profileId: sample.claim.profileId,
      limits: sample.claim.limits,
      sources: [...sample.claim.sources],
    };
    const configuration = captureInvestigation(intent, {
      profile: {
        id: intent.profileId,
        revision: 1,
        scope: { workspaceId: scope, serviceId: "api", environmentId: "prod" },
        destination: sample.result.report.destination,
        endpoint: "http://127.0.0.1:11434",
        secretId: null,
      },
      secretIds: [],
      sourceVersions: [{ kind: "log", sourceId: "source_a", revision: "1" }],
    }).configuration;
    sample.result.report.usage.evidenceBytes = Buffer.byteLength(
      JSON.stringify(sample.result.evidence),
      "utf8",
    );
    let expireDuringAuthorization = false;
    const revoked = new Set<string>();
    const policy: InvestigationDatabasePolicy = {
      authorizeRuntime: async (_db, workspaceId, runtimeId) =>
        workspaceId === scope &&
        ["runtime_a", "runtime_b"].includes(runtimeId) &&
        !revoked.has(runtimeId),
      configuration: async (_db, binding, id) => {
        if (expireDuringAuthorization) {
          await _db.query(
            "UPDATE escalator_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",
            [scope, intent.id],
          );
        }
        return binding.workspaceId === scope &&
          binding.serviceId === "api" &&
          binding.environmentId === "prod" &&
          id === intent.profileId
          ? configuration
          : undefined;
      },
    };
    const reopen = () =>
      new PostgresInvestigationRepository(database.app, policy);
    const repository = reopen();
    // Reserve before any claim; observing commit must not reuse its transaction connection.
    observer = await database.app.connect();
    const reserved = observer;
    const query = async <T>(
      workspaceId: WorkspaceId,
      work: (client: typeof reserved) => Promise<T>,
    ) => {
      const client = await database.app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    return {
      reports: new PostgresInvestigationReportRepository(database.app),
      async disableResponder() {
        await query(scope, async (db) => {
          await db.query(
            "UPDATE escalator_responder SET enabled=false WHERE workspace_id=$1 AND id='primary'",
            [scope],
          );
        });
      },
      expireDuringAuthorization() {
        expireDuringAuthorization = true;
      },
      maxAttempts: 3,
      async changeConfiguration(kind) {
        if (kind === "profile") configuration.profile.revision++;
        else configuration.sourceVersions[0].revision = "2";
      },
      intent,
      result: sample.result,
      otherScope: { ...intent.scope, workspaceId: other },
      repository,
      reopen,
      writer: { enqueue: (input) => repository.enqueue(input) },
      trace: repository.trace,
      async expire(claim) {
        await query(claim.scope.workspaceId, async (db) => {
          await db.query(
            `UPDATE escalator_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2 AND lease_token=$3`,
            [claim.scope.workspaceId, claim.id, claim.claimToken],
          );
        });
      },
      async revokeRuntime(runtimeId) {
        revoked.add(runtimeId);
      },
      async traces() {
        return query(scope, async (db) => {
          const rows = await db.query<{
            data: Awaited<
              ReturnType<InvestigationPersistenceFixture["traces"]>
            >[number];
          }>(
            `SELECT t.data FROM escalator_investigation_trace t JOIN escalator_job j ON j.workspace_id=t.workspace_id AND j.id=t.investigation_id WHERE t.workspace_id=$1 AND t.investigation_id=$2 AND t.attempt=j.attempt_count ORDER BY t.sequence`,
            [scope, intent.id],
          );
          return rows.rows.map((row) => row.data);
        });
      },
      async committed(claim) {
        try {
          await reserved.query("BEGIN");
          await reserved.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [scope],
          );
          const rows = await reserved.query(
            `SELECT j.id FROM escalator_job j JOIN escalator_investigation i ON i.workspace_id=j.workspace_id AND i.id=j.id WHERE j.workspace_id=$1 AND j.id=$2 AND j.state='running' AND j.lease_token=$3 AND i.runtime_id=$4`,
            [scope, claim.id, claim.claimToken, claim.runtimeId],
          );
          return rows.rowCount === 1;
        } finally {
          await reserved.query("ROLLBACK");
        }
      },
      async dispose() {
        reserved.release();
        await database.dispose();
      },
    };
  } catch (error) {
    observer?.release();
    await database.dispose();
    throw error;
  }
}
const configured = testDatabaseConfigured();
investigationPersistenceConformance(
  "PostgreSQL investigation persistence",
  create,
  (name, run) =>
    test(
      name,
      configured
        ? {}
        : {
            skip: "Not runtime-verified: no explicit disposable PostgreSQL test database",
          },
      run,
    ),
);

test(
  "live investigation profile and native reads reject expired and widened claims",
  { skip: !configured },
  async () => {
    const f = await create();
    try {
      await f.writer.enqueue(f.intent);
      const claim = await f.repository.claim({
        workspaceId: f.intent.scope.workspaceId,
        runtimeId: "runtime_a",
        claimToken: "read_fence",
        leaseMs: 30000,
      });
      assert.ok(claim);
      const repository = f.repository as PostgresInvestigationRepository;
      assert.equal((await repository.readProfile(claim))?.id, claim.profileId);
      const query = { ...claim.sources[0], sourceId: "unselected" };
      const denied = await repository.readNativeEvidence(claim, query, 8192);
      assert.equal(denied.status, "unavailable");
      if (denied.status === "unavailable")
        assert.equal(denied.unavailable.reason, "not_authorized");
      f.expireDuringAuthorization();
      assert.equal(await repository.readProfile(claim), undefined);
      const expired = await repository.readNativeEvidence(
        claim,
        claim.sources[0],
        8192,
      );
      assert.equal(expired.status, "unavailable");
      if (expired.status === "unavailable")
        assert.equal(expired.unavailable.reason, "not_authorized");
    } finally {
      await f.dispose();
    }
  },
);

investigationReportConformance(
  "PostgreSQL human investigation reports",
  create,
  (name, run) => test(name, { skip: !configured }, run),
);
