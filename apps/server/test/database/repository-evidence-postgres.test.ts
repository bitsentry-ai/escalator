import { modelProfileSchema } from "@bitsentry-escalator/features/investigation";
import { operationalIncidentSchema } from "@bitsentry-escalator/features/contracts";
import { PostgresInvestigationRepository } from "../../src/platform/database/postgres-investigation.repository.js";
import { PostgresInvestigationSourceCatalog } from "../../src/platform/database/investigation-source-catalog.repository.js";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import { investigationSettingsSchema } from "@bitsentry-escalator/features/contracts";
import {
  sameInvestigationConfiguration,
  repositoryConnectionRevision,
  repositoryConnectionSchema,
} from "@bitsentry-escalator/features/investigation";
import { openPageInTransaction } from "@bitsentry-escalator/features/application";
import { PostgresPagingRepository } from "../../src/platform/database/paging.repository.js";
import { postgresInvestigationSettingsStore } from "../../src/platform/database/postgres-investigation-settings.store.js";
import { standaloneInvestigationConfiguration } from "../../src/features/escalator/investigation/configuration.js";
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "@escalator-test/deployments";
import {
  workspaceIdSchema,
  investigationScopeSchema,
  evidenceQuerySchema,
  deploymentSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  RepositoryConnections,
  GithubDiffError,
} from "@bitsentry-escalator/features/investigation";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresDeploymentRepository } from "../../src/platform/database/deployments.repository.js";
import { postgresDeploymentStore } from "../../src/platform/database/postgres-deployments.store.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
import {
  readRepositoryBinding,
  readRepositoryComparison,
} from "../../src/platform/database/postgres-repository-evidence.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const scope = (workspaceId: WorkspaceId) =>
  investigationScopeSchema.parse({
    workspaceId,
    serviceId: "api",
    environmentId: "prod",
    incidentId: "incident",
  });
const connection = (workspaceId: WorkspaceId) =>
  repositoryConnectionSchema.parse({
    scope: { workspaceId, serviceId: "api", environmentId: "prod" },
    sourceId: "repository",
    name: "API",
    targetId: "target",
    owner: "bitsentry-ai",
    repository: "api",
    secretId: null,
    enabled: true,
  });
const query = evidenceQuerySchema.parse({
  kind: "git_diff",
  sourceId: "repository",
  window: { from: "2026-10-01T01:00:00.000Z", to: "2026-10-01T01:05:00.000Z" },
  limit: 5,
});
const asOf = "2026-10-01T02:00:00.000Z";
async function fixture() {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  const result = {
    database,
    repository: new PostgresDeploymentRepository(database.app),
    configuration: new PostgresConfigurationRepository(database.app),
    work: new PostgresWorkStore(database.app),
    foundation: new PostgresFoundationRepository(database.app),
    dispose: () => database.dispose(),
  };
  const a = workspaceIdSchema.parse("repository_a_" + randomUUID()),
    b = workspaceIdSchema.parse("repository_b_" + randomUUID());
  try {
    await seedDeploymentFixture(result, a);
    await seedDeploymentFixture(result, b);
    return { ...result, a, b };
  } catch (error) {
    await result.dispose();
    throw error;
  }
}
async function record(
  f: Awaited<ReturnType<typeof fixture>>,
  workspaceId: WorkspaceId,
  id: string,
  kind: "base" | "head" | "late",
  commit: string,
) {
  const entry = await f.repository.transaction(workspaceId, (tx) =>
    fixtureDeployment(tx, id),
  );
  // Seed retained history directly: live ingress deliberately rejects backdated
  // acceptance times and inserting an already-terminal deployment.
  await f.foundation.withConnection(workspaceId, async (_base, db) => {
    const successful = kind !== "head";
    const start =
      kind === "head" ? "2026-10-01T01:00:00.000Z" : "2026-10-01T00:00:00.000Z";
    const accepted =
      kind === "head" ? "2026-10-01T01:00:01.000Z" : "2026-10-01T00:00:01.000Z";
    const finishAt =
      kind === "late" ? "2026-10-01T00:50:00.000Z" : "2026-10-01T00:10:00.000Z";
    const received =
      kind === "late" ? "2026-10-01T01:01:00.000Z" : "2026-10-01T00:10:01.000Z";
    await postgresDeploymentStore(db, workspaceId).insertDeployment({
      ...entry,
      deployment: deploymentSchema.parse({
        ...entry.deployment,
        commit,
        startedAt: start,
        acceptedAt: accepted,
        timeoutAt:
          kind === "head"
            ? "2026-10-01T01:10:00.000Z"
            : "2026-10-01T00:10:00.000Z",
        updatedAt: successful ? received : accepted,
        status: successful ? "SUCCEEDED" : "STARTED",
        revision: successful ? 2 : 1,
        finish: successful
          ? {
              outcome: "SUCCEEDED",
              actor: "ci",
              occurredAt: finishAt,
              receivedAt: received,
            }
          : null,
      }),
    });
  });
}
test(
  "repository metadata is isolated by workspace RLS even with populated identical target IDs",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.foundation.withConnection(f.a, async (_base, db) => {
        assert.ok(
          await readRepositoryBinding(
            db,
            scope(f.a),
            "repository",
            new RepositoryConnections([connection(f.a)]),
          ),
        );
        assert.equal(
          await readRepositoryBinding(
            db,
            scope(f.b),
            "repository",
            new RepositoryConnections([connection(f.b)]),
          ),
          undefined,
        );
      });
    } finally {
      await f.dispose();
    }
  },
);
test(
  "disabled targets and missing private credentials deny repository metadata",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.foundation.withConnection(f.a, async (_base, db) => {
        assert.equal(
          await readRepositoryBinding(
            db,
            scope(f.a),
            "repository",
            new RepositoryConnections([
              { ...connection(f.a), secretId: "missing" },
            ]),
          ),
          undefined,
        );
        await db.query(
          "UPDATE escalator_deploy_target SET data=jsonb_set(data,'{enabled}','false'::jsonb) WHERE workspace_id=$1 AND id='target'",
          [f.a],
        );
        assert.equal(
          await readRepositoryBinding(
            db,
            scope(f.a),
            "repository",
            new RepositoryConnections([connection(f.a)]),
          ),
          undefined,
        );
      });
    } finally {
      await f.dispose();
    }
  },
);
test(
  "repository comparison selects the prior known successful deployment without late-finish hindsight or tenant leakage",
  options,
  async () => {
    const f = await fixture();
    try {
      await record(f, f.a, "base", "base", "a".repeat(40));
      await record(f, f.a, "late", "late", "c".repeat(40));
      await record(f, f.a, "head", "head", "b".repeat(40));
      await record(f, f.b, "base", "base", "d".repeat(40));
      await record(f, f.b, "head", "head", "e".repeat(40));
      await f.foundation.withConnection(f.a, async (_base, db) => {
        const selected = await readRepositoryComparison(
          db,
          scope(f.a),
          query,
          connection(f.a),
          asOf,
        );
        assert.equal(selected?.baseSha, "a".repeat(40));
        assert.equal(selected?.headSha, "b".repeat(40));
        await assert.rejects(
          readRepositoryComparison(
            db,
            scope(f.b),
            query,
            connection(f.b),
            asOf,
          ),
          (error) =>
            error instanceof GithubDiffError && error.reason === "not_found",
        );
      });
    } finally {
      await f.dispose();
    }
  },
);
test(
  "repository comparison cannot invent a baseline or expand an abbreviated deployment commit",
  options,
  async () => {
    const f = await fixture();
    try {
      await record(f, f.a, "head", "head", "abc123");
      await f.foundation.withConnection(f.a, async (_base, db) => {
        await assert.rejects(
          readRepositoryComparison(
            db,
            scope(f.a),
            query,
            connection(f.a),
            asOf,
          ),
          (error) =>
            error instanceof GithubDiffError && error.reason === "not_found",
        );
      });
      await record(f, f.a, "base", "base", "a".repeat(40));
      await f.foundation.withConnection(f.a, async (_base, db) => {
        await assert.rejects(
          readRepositoryComparison(
            db,
            scope(f.a),
            query,
            connection(f.a),
            asOf,
          ),
          (error) =>
            error instanceof GithubDiffError &&
            error.reason === "invalid_configuration",
        );
      });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "first-page persistence captures repository revisions atomically and later operator edits cannot reuse that configuration",
  options,
  async () => {
    const f = await fixture();
    try {
      const sample = investigationFixture();
      const connections = new RepositoryConnections([connection(f.a)]);
      await f.foundation.withConnection(f.a, async (base, db) => {
        const value = investigationSettingsSchema.parse({
          profile: {
            id: "profile",
            revision: 1,
            scope: {
              workspaceId: f.a,
              serviceId: "api",
              environmentId: "prod",
            },
            destination: sample.result.report.destination,
            endpoint: "http://127.0.0.1:11434",
            secretId: null,
          },
          enabled: true,
          limits: sample.claim.limits,
          sources: [
            {
              kind: "git_diff",
              sourceId: "repository",
              lookbackMs: 60000,
              limit: 5,
            },
          ],
          createdAt: base.now,
          updatedAt: base.now,
        });
        assert.equal(
          await postgresInvestigationSettingsStore(db, f.a, connections).put(
            value,
            null,
          ),
          true,
        );
      });
      const paging = new PostgresPagingRepository(f.database.app, connections);
      const page = await paging.transaction(f.a, async (tx) => {
        const seed = (await tx.pages.get("page"))!;
        return openPageInTransaction(tx, {
          incident: {
            id: "repository_incident",
            serviceId: scope(f.a).serviceId,
            environmentId: scope(f.a).environmentId,
            title: "Outage",
            severity: "critical",
          },
          policy: seed.policy,
        });
      });
      await f.foundation.withConnection(f.a, async (_base, db) => {
        const result = await db.query(
          "SELECT configuration FROM escalator_investigation WHERE workspace_id=$1 AND incident_id=$2",
          [f.a, page.incidentId],
        );
        assert.equal(result.rows.length, 1);
        const captured = result.rows[0].configuration;
        assert.deepEqual(captured.sourceVersions, [
          {
            kind: "git_diff",
            sourceId: "repository",
            revision: repositoryConnectionRevision(connection(f.a), "1"),
          },
        ]);
        assert.deepEqual(captured.secretIds, []);
        const incidentScope = { ...scope(f.a), incidentId: page.incidentId };
        assert.equal(
          sameInvestigationConfiguration(
            captured,
            await standaloneInvestigationConfiguration(
              db,
              incidentScope,
              "profile",
              connections,
            ),
          ),
          true,
        );
        const changed = new RepositoryConnections([
          { ...connection(f.a), repository: "different" },
        ]);
        assert.equal(
          sameInvestigationConfiguration(
            captured,
            await standaloneInvestigationConfiguration(
              db,
              incidentScope,
              "profile",
              changed,
            ),
          ),
          false,
        );
      });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "repository source choices hide credential and target IDs and report disabled bindings",
  options,
  async () => {
    const f = await fixture();
    try {
      const connections = new RepositoryConnections([
        { ...connection(f.a), secretId: "unavailable_private_key" },
      ]);
      const catalog = new PostgresInvestigationSourceCatalog(
        f.database.app,
        connections,
      );
      const page = await catalog.list(f.a, {
        serviceId: scope(f.a).serviceId,
        environmentId: scope(f.a).environmentId,
        kind: "git_diff",
        limit: 10,
      });
      assert.deepEqual(page.items, [
        {
          kind: "git_diff",
          sourceId: "repository",
          name: "API",
          enabled: false,
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(page),
        /unavailable_private_key|secretId|targetId/,
      );
      const foreign = await catalog.list(f.b, {
        serviceId: scope(f.b).serviceId,
        environmentId: scope(f.b).environmentId,
        kind: "git_diff",
        limit: 10,
      });
      assert.deepEqual(foreign, { items: [], next: null });
    } finally {
      await f.dispose();
    }
  },
);

for (const change of [
  "none",
  "query",
  "runtime",
  "lease",
  "target",
  "revision",
] as const) {
  test(
    `claim-bound repository snapshot fences ${change}`,
    options,
    async () => {
      const f = await fixture();
      try {
        await record(f, f.a, "base", "base", "a".repeat(40));
        await record(f, f.a, "head", "head", "b".repeat(40));
        const sample = investigationFixture();
        const connections = new RepositoryConnections([connection(f.a)]);
        const paging = new PostgresPagingRepository(
          f.database.app,
          connections,
        );
        await paging.transaction(f.a, async (tx) => {
          await tx.incidents.insert(
            operationalIncidentSchema.parse({
              id: "repository_claim_incident",
              workspaceId: f.a,
              serviceId: "api",
              environmentId: "prod",
              title: "Outage",
              severity: "critical",
              openedAt: tx.now,
              resolvedAt: null,
            }),
          );
        });
        const selectedScope = investigationScopeSchema.parse({
          ...scope(f.a),
          incidentId: "repository_claim_incident",
        });
        const configuration = {
          profile: modelProfileSchema.parse({
            id: "repository_profile",
            revision: 1,
            scope: {
              workspaceId: f.a,
              serviceId: "api",
              environmentId: "prod",
            },
            destination: sample.result.report.destination!,
            endpoint: "http://127.0.0.1:11434",
            secretId: null,
          }),
          secretIds: [],
          sourceVersions: [
            {
              kind: "git_diff" as const,
              sourceId: "repository",
              revision: repositoryConnectionRevision(connection(f.a), "1"),
            },
          ],
        };
        let allowed = true;
        const investigations = new PostgresInvestigationRepository(
          f.database.app,
          {
            authorizeRuntime: async (_db, workspace, runtime) =>
              allowed && workspace === f.a && runtime === "repository_runtime",
            configuration: async () => configuration,
          },
          3,
          connections,
        );
        await investigations.enqueue({
          id: "repository_investigation",
          scope: selectedScope,
          profileId: configuration.profile.id,
          limits: sample.claim.limits,
          sources: [query],
          idempotencyKey: "repository_claim",
        });
        const claim = await investigations.claim({
          workspaceId: f.a,
          runtimeId: "repository_runtime",
          claimToken: "repository_claim_token",
          leaseMs: 30000,
        });
        assert.ok(claim);
        const before = await investigations.readRepositoryEvidence(
          claim,
          query,
        );
        assert.ok(before);
        assert.equal(before.secret, null);
        assert.equal(before.comparison.headSha, "b".repeat(40));
        if (change === "runtime") allowed = false;
        if (["lease", "target", "revision"].includes(change))
          await f.foundation.withConnection(f.a, async (_base, db) => {
            if (change === "lease")
              await db.query(
                "UPDATE escalator_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id='repository_investigation'",
                [f.a],
              );
            else if (change === "target")
              await db.query(
                "UPDATE escalator_deploy_target SET data=jsonb_set(data,'{enabled}','false'::jsonb) WHERE workspace_id=$1 AND id='target'",
                [f.a],
              );
            else if (change === "revision")
              await db.query(
                "UPDATE escalator_deploy_target SET revision=revision+1,data=jsonb_set(data,'{revision}',to_jsonb(revision+1)) WHERE workspace_id=$1 AND id='target'",
                [f.a],
              );
          });
        const after = await investigations.readRepositoryEvidence(
          claim,
          change === "query" ? { ...query, limit: query.limit + 1 } : query,
        );
        if (change === "none")
          assert.deepEqual(after?.comparison, before.comparison);
        else assert.equal(after, undefined);
      } finally {
        await f.dispose();
      }
    },
  );
}
