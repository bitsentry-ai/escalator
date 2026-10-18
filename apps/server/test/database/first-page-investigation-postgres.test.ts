import { PostgresInvestigationRepository } from "../../src/platform/database/postgres-investigation.repository.js";
import { standaloneInvestigationConfiguration } from "../../src/features/escalator/investigation/configuration.js";
import { readNativeEvidence } from "../../src/platform/database/postgres-native-evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  workspaceIdSchema,
  investigationSettingsSchema,
  signalSourceSchema,
  signalEventSchema,
  investigationScopeSchema,
  evidenceQuerySchema,
} from "@bitsentry-escalator/features/contracts";
import { openPageInTransaction } from "@bitsentry-escalator/features/application";
import { seedPagingFixture } from "@escalator-test/paging";
import { investigationFixture } from "@escalator-test/investigation-fixture";
import { PostgresPagingRepository } from "../../src/platform/database/paging.repository.js";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";
import { postgresInvestigationSettingsStore } from "../../src/platform/database/postgres-investigation-settings.store.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
import { postgresSignalStore } from "../../src/platform/database/postgres-signals.store.js";
const skip = !testDatabaseConfigured();
async function fixture(enabled: boolean | undefined) {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  try {
    const workspaceId = workspaceIdSchema.parse("first_page_" + randomUUID());
    const paging = new PostgresPagingRepository(database.app);
    const foundation = new PostgresFoundationRepository(database.app);
    await paging.transaction(workspaceId, seedPagingFixture);
    const sample = investigationFixture();
    if (enabled !== undefined)
      await foundation.withConnection(workspaceId, async (base, db) => {
        await postgresSignalStore(db, workspaceId).insertSource(
          signalSourceSchema.parse({
            id: "source",
            workspaceId,
            serviceId: "api",
            environmentId: "prod",
            name: "Errors",
            kind: "generic",
            enabled: true,
            version: 3,
            grouping: "source-fingerprint",
            recovery: "explicit",
            recoveryHoldSeconds: 60,
            authSecretId: null,
            createdAt: base.now,
            updatedAt: base.now,
          }),
        );
        const value = investigationSettingsSchema.parse({
          profile: {
            id: "profile",
            revision: 1,
            scope: { workspaceId, serviceId: "api", environmentId: "prod" },
            destination: sample.result.report.destination,
            endpoint: "http://127.0.0.1:11434",
            secretId: null,
          },
          enabled,
          limits: sample.claim.limits,
          sources: [
            { kind: "alert", sourceId: "source", lookbackMs: 60000, limit: 3 },
            { kind: "alert", sourceId: "removed", lookbackMs: 60000, limit: 3 },
          ],
          createdAt: base.now,
          updatedAt: base.now,
        });
        assert.equal(
          await postgresInvestigationSettingsStore(db, workspaceId).put(
            value,
            null,
          ),
          true,
        );
      });
    const open = () =>
      paging.transaction(workspaceId, async (tx) => {
        const seed = (await tx.pages.get("page"))!;
        return openPageInTransaction(tx, {
          incident: {
            id: "first",
            serviceId: seed.policy.serviceId,
            environmentId: sample.claim.scope.environmentId,
            title: "Outage",
            severity: "critical",
          },
          policy: seed.policy,
        });
      });
    const inspect = () =>
      foundation.withConnection(workspaceId, async (_base, db) => {
        const rows = await db.query(
          "SELECT i.id,i.configuration,i.sources,j.state FROM escalator_investigation i JOIN escalator_job j ON j.workspace_id=i.workspace_id AND j.id=i.id WHERE i.workspace_id=$1",
          [workspaceId],
        );
        return rows.rows;
      });
    return { database, workspaceId, paging, foundation, open, inspect };
  } catch (error) {
    await database.dispose();
    throw error;
  }
}
test(
  "PostgreSQL first page atomically persists one investigation across duplicate requests",
  { skip },
  async () => {
    const f = await fixture(true);
    try {
      const first = await f.open();
      assert.equal((await f.open()).id, first.id);
      const rows = await f.inspect();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].configuration.profile.id, "profile");
      assert.deepEqual(rows[0].configuration.sourceVersions, [
        { kind: "alert", sourceId: "source", revision: "3" },
        { kind: "alert", sourceId: "removed", revision: "missing" },
      ]);
      assert.equal(rows[0].sources.length, 2);
      assert.equal(rows[0].sources[0].window.to, first.createdAt);
      assert.equal(
        Date.parse(rows[0].sources[0].window.to) -
          Date.parse(rows[0].sources[0].window.from),
        60000,
      );
      assert.deepEqual(rows[0].configuration.secretIds, []);
    } finally {
      await f.database.dispose();
    }
  },
);
for (const enabled of [undefined, false])
  test(
    `PostgreSQL first page with settings ${String(enabled)} creates no investigation`,
    { skip },
    async () => {
      const f = await fixture(enabled);
      try {
        assert.equal((await f.open()).state, "open");
        assert.deepEqual(await f.inspect(), []);
      } finally {
        await f.database.dispose();
      }
    },
  );
test(
  "PostgreSQL rollback removes first page and investigation together",
  { skip },
  async () => {
    const f = await fixture(true);
    try {
      await assert.rejects(
        f.paging.transaction(f.workspaceId, async (tx) => {
          const seed = (await tx.pages.get("page"))!;
          await openPageInTransaction(tx, {
            incident: {
              id: "rollback",
              serviceId: seed.policy.serviceId,
              environmentId: investigationFixture().claim.scope.environmentId,
              title: "Outage",
              severity: "critical",
            },
            policy: seed.policy,
          });
          throw new Error("rollback");
        }),
      );
      assert.deepEqual(await f.inspect(), []);
      await f.paging.transaction(f.workspaceId, async (tx) =>
        assert.equal(await tx.incidents.get("rollback"), undefined),
      );
    } finally {
      await f.database.dispose();
    }
  },
);

test(
  "native alert SQL preserves receipts, omits attributes and scopes source reads",
  { skip },
  async () => {
    const f = await fixture(true);
    try {
      await f.foundation.withConnection(f.workspaceId, async (base, native) => {
        const db = native;
        const event = signalEventSchema.parse({
          id: "signal",
          workspaceId: f.workspaceId,
          version: 1,
          serviceId: "api",
          environmentId: "prod",
          sourceId: "source",
          eventId: "provider-event",
          fingerprint: "group",
          observedAt: base.now,
          receivedAt: base.now,
          status: "active",
          severity: "critical",
          title: "Errors",
          evidence: {
            summary: "authorization: Bearer private-value",
            attributes: [{ name: "private", value: "must-not-leak" }],
          },
        });
        await postgresSignalStore(native, f.workspaceId).insertSignal(event);
        const scope = investigationScopeSchema.parse({
          workspaceId: f.workspaceId,
          serviceId: "api",
          environmentId: "prod",
          incidentId: "incident",
        });
        const query = evidenceQuerySchema.parse({
          kind: "alert",
          sourceId: "source",
          window: { from: base.now, to: base.now },
          limit: 1,
        });
        const result = await readNativeEvidence(
          db,
          scope,
          query,
          base.now,
          8192,
        );
        assert.equal(result.status, "available");
        if (result.status !== "available") return;
        assert.equal(result.items[0].reference.receivedAt, event.receivedAt);
        assert.doesNotMatch(
          result.items[0].text,
          /private-value|must-not-leak/,
        );
        assert.equal(
          (
            await readNativeEvidence(
              db,
              investigationScopeSchema.parse({ ...scope, serviceId: "other" }),
              query,
              base.now,
              8192,
            )
          ).status,
          "unavailable",
        );
      });
    } finally {
      await f.database.dispose();
    }
  },
);

test(
  "standalone live policy consumes first-page capture and fences disabled settings",
  { skip },
  async () => {
    const f = await fixture(true);
    try {
      await f.open();
      await f.foundation.withConnection(f.workspaceId, async (_base, db) => {
        const scope = investigationScopeSchema.parse({
          workspaceId: f.workspaceId,
          serviceId: "api",
          environmentId: "prod",
          incidentId: "first",
        });
        assert.ok(
          await standaloneInvestigationConfiguration(db, scope, "profile"),
        );
        const peer = await f.database.app.connect();
        try {
          await peer.query("BEGIN");
          await peer.query("SELECT set_config('app.workspace_id',$1,true)", [
            f.workspaceId,
          ]);
          // These are the row lock modes acquired by FK checks while opening a page.
          assert.equal(
            (
              await peer.query(
                "SELECT id FROM escalator_service WHERE workspace_id=$1 AND id='api' FOR KEY SHARE NOWAIT",
                [f.workspaceId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await peer.query(
                "SELECT id FROM escalator_environment WHERE workspace_id=$1 AND id='prod' FOR KEY SHARE NOWAIT",
                [f.workspaceId],
              )
            ).rowCount,
            1,
          );
        } finally {
          await peer.query("ROLLBACK");
          peer.release();
        }
      });
      const repository = new PostgresInvestigationRepository(f.database.app, {
        authorizeRuntime: async (_db, workspaceId, runtimeId) =>
          workspaceId === f.workspaceId && runtimeId === "runner",
        configuration: standaloneInvestigationConfiguration,
      });
      const claim = await repository.claim({
        workspaceId: f.workspaceId,
        runtimeId: "runner",
        claimToken: "runner_claim",
        leaseMs: 30000,
      });
      assert.ok(claim);
      assert.equal((await repository.readProfile(claim))?.id, "profile");
      const empty = await repository.readNativeEvidence(
        claim,
        claim.sources[0],
        8192,
      );
      assert.equal(empty.status, "unavailable");
      if (empty.status === "unavailable")
        assert.equal(empty.unavailable.reason, "not_found");
      assert.equal(
        await repository.readModelSecret(claim, "unapproved"),
        undefined,
      );
      await f.foundation.withConnection(f.workspaceId, async (base, db) => {
        const store = postgresInvestigationSettingsStore(db, f.workspaceId);
        const current = await store.selected(claim.scope);
        assert.ok(current);
        assert.equal(
          await store.put(
            {
              ...current,
              enabled: false,
              profile: {
                ...current.profile,
                revision: current.profile.revision + 1,
              },
              updatedAt: base.now,
            },
            current.profile.revision,
          ),
          true,
        );
      });
      assert.equal(await repository.readProfile(claim), undefined);
      assert.equal(await repository.heartbeat(claim, 30000), undefined);
    } finally {
      await f.database.dispose();
    }
  },
);

test(
  "standalone service disablement fences production investigation reads and renewal",
  { skip },
  async () => {
    const f = await fixture(true);
    try {
      await f.open();
      const repository = new PostgresInvestigationRepository(f.database.app, {
        authorizeRuntime: async (_db, workspaceId, runtimeId) =>
          workspaceId === f.workspaceId && runtimeId === "runner",
        configuration: standaloneInvestigationConfiguration,
      });
      const claim = await repository.claim({
        workspaceId: f.workspaceId,
        runtimeId: "runner",
        claimToken: "service_claim",
        leaseMs: 30000,
      });
      assert.ok(claim);
      assert.equal((await repository.readProfile(claim))?.id, "profile");
      await f.foundation.withConnection(f.workspaceId, async (_base, db) => {
        await db.query(
          "UPDATE escalator_service SET enabled=false,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id='api'",
          [f.workspaceId],
        );
      });
      assert.equal(await repository.readProfile(claim), undefined);
      assert.equal(await repository.heartbeat(claim, 30000), undefined);
    } finally {
      await f.database.dispose();
    }
  },
);
