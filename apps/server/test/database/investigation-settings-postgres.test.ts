import test from "node:test";
import type { PoolClient, QueryResult } from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  workspaceIdSchema,
  responderIdSchema,
  serviceIdSchema,
  environmentIdSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import { InvestigationSettingsUseCases } from "@bitsentry-escalator/features/application";
import { seedSignalFixture } from "@escalator-test/signals";
import { PostgresSignalRepository } from "../../src/platform/database/signals.repository.js";
import { PostgresInvestigationSourceCatalog } from "../../src/platform/database/investigation-source-catalog.repository.js";
import { PostgresInvestigationSettingsRepository } from "../../src/platform/database/investigation-settings.repository.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const skip = !testDatabaseConfigured();
async function fixture() {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
  );
  try {
    const workspaceId = workspaceIdSchema.parse("settings_" + randomUUID());
    const other = workspaceIdSchema.parse("settings_" + randomUUID());
    const signals = new PostgresSignalRepository(database.app);
    for (const scope of [workspaceId, other])
      await signals.transaction(scope, seedSignalFixture);
    const repository = new PostgresInvestigationSettingsRepository(
      database.app,
    );
    const useCases = new InvestigationSettingsUseCases(repository, randomUUID);
    const actor: Actor = {
      workspaceId,
      responderId: responderIdSchema.parse("owner"),
      role: "administrator",
    };
    const input = {
      serviceId: serviceIdSchema.parse("service"),
      environmentId: environmentIdSchema.parse("production"),
      enabled: true,
      destination: {
        provider: "ollama" as const,
        model: "local",
        location: "local" as const,
        origin: "http://127.0.0.1:11434",
      },
      endpoint: "http://127.0.0.1:11434",
      secretId: null,
      limits: {
        maxDurationMs: 60000,
        maxModelCalls: 1,
        maxEvidenceReads: 4,
        maxEvidenceBytes: 32768,
        maxOutputTokens: 1024,
        maxTraceEvents: 32,
      },
      sources: [
        {
          kind: "alert" as const,
          sourceId: "source",
          lookbackMs: 60000,
          limit: 10,
        },
      ],
    };
    return {
      database,
      workspaceId,
      other,
      repository,
      useCases,
      actor,
      input,
      dispose: () => database.dispose(),
    };
  } catch (error) {
    await database.dispose();
    throw error;
  }
}
test(
  "PostgreSQL model settings and normalized links round trip in the selected scope",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const value = await f.useCases.create(f.actor, f.input);
      assert.deepEqual(await f.useCases.get(f.actor, f.input), value);
      assert.equal(
        await f.useCases.get({ ...f.actor, workspaceId: f.other }, f.input),
        undefined,
      );
      const changed = await f.useCases.update(f.actor, {
        id: value.profile.id,
        expectedRevision: 1,
        enabled: false,
        destination: value.profile.destination,
        endpoint: value.profile.endpoint,
        secretId: null,
        limits: value.limits,
        sources: [],
      });
      assert.equal(changed.profile.revision, 2);
      assert.deepEqual((await f.useCases.get(f.actor, f.input))?.sources, []);
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL simultaneous model selection has one winner",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.allSettled([
        f.useCases.create(f.actor, f.input),
        f.useCases.create(f.actor, f.input),
      ]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL refuses unknown and external unlinked sources and secrets",
  { skip },
  async () => {
    const f = await fixture();
    try {
      for (const input of [
        { ...f.input, secretId: "absent" },
        {
          ...f.input,
          sources: [{ ...f.input.sources[0], sourceId: "absent" }],
        },
        {
          ...f.input,
          sources: [{ ...f.input.sources[0], kind: "log" as const }],
        },
      ])
        await assert.rejects(f.useCases.create(f.actor, input), {
          code: "not_found",
        });
      assert.equal(await f.useCases.get(f.actor, f.input), undefined);
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL concurrent profile edits reject stale revisions",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const value = await f.useCases.create(f.actor, f.input);
      const edit = {
        id: value.profile.id,
        expectedRevision: 1,
        enabled: false,
        destination: value.profile.destination,
        endpoint: value.profile.endpoint,
        secretId: null,
        limits: value.limits,
        sources: value.sources,
      };
      const outcomes = await Promise.allSettled([
        f.useCases.update(f.actor, edit),
        f.useCases.update(f.actor, edit),
      ]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        (await f.useCases.get(f.actor, f.input))?.profile.revision,
        2,
      );
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL profile and source-link changes roll back with their enclosing transaction",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const value = await f.useCases.create(f.actor, f.input);
      await assert.rejects(
        f.repository.transaction(f.workspaceId, async (tx) => {
          await tx.investigationSettings.save(
            f.actor,
            {
              ...value,
              profile: { ...value.profile, revision: 2 },
              sources: [],
              updatedAt: tx.now,
            },
            1,
          );
          throw new Error("abort fixture transaction");
        }),
        /abort fixture transaction/,
      );
      assert.deepEqual(await f.useCases.get(f.actor, f.input), value);
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL forced row security hides profile and links outside their workspace",
  { skip },
  async () => {
    const f = await fixture();
    let db: PoolClient | undefined;
    try {
      const value = await f.useCases.create(f.actor, f.input);
      db = await f.database.app.connect();
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [
        f.other,
      ]);
      for (const table of [
        "escalator_investigation_settings",
        "escalator_investigation_source_link",
      ]) {
        const rows: QueryResult = await db.query(
          `SELECT * FROM ${table} WHERE workspace_id=$1`,
          [f.workspaceId],
        );
        assert.equal(rows.rowCount, 0);
      }
      const mutation = await db.query(
        "UPDATE escalator_investigation_settings SET enabled=false WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, value.profile.id],
      );
      assert.equal(mutation.rowCount, 0);
    } finally {
      if (db) {
        await db.query("ROLLBACK");
        db.release();
      }
      await f.dispose();
    }
  },
);

test(
  "PostgreSQL source catalog paginates only the requested native scope",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const signals = new PostgresSignalRepository(f.database.app);
      await signals.transaction(f.workspaceId, async (tx) => {
        const original = await tx.sources.get("source");
        assert.ok(original);
        for (const id of ["private_a", "private_b"])
          await tx.sources.insert({
            ...original,
            id,
            enabled: id !== "private_b",
            createdAt: tx.now,
            updatedAt: tx.now,
          });
      });
      const catalog = new PostgresInvestigationSourceCatalog(f.database.app);
      const query = {
        serviceId: f.input.serviceId,
        environmentId: f.input.environmentId,
        kind: "alert" as const,
        limit: 1,
      };
      const first = await catalog.list(f.workspaceId, query);
      assert.equal(first.items[0].sourceId, "private_a");
      assert.equal(first.next, "private_a");
      const second = await catalog.list(f.workspaceId, {
        ...query,
        after: first.next!,
      });
      assert.equal(second.items[0].sourceId, "private_b");
      assert.equal(second.items[0].enabled, false);
      const other = await catalog.list(f.other, { ...query, limit: 100 });
      assert.deepEqual(
        other.items.map((x) => x.sourceId),
        ["source"],
      );
      const external = await catalog.list(f.workspaceId, {
        ...query,
        kind: "log",
      });
      assert.deepEqual(external, { items: [], next: null });
    } finally {
      await f.dispose();
    }
  },
);
test(
  "PostgreSQL cannot bind a source owned only by another workspace",
  { skip },
  async () => {
    const f = await fixture();
    try {
      const signals = new PostgresSignalRepository(f.database.app);
      await signals.transaction(f.other, async (tx) => {
        const original = await tx.sources.get("source");
        assert.ok(original);
        await tx.sources.insert({
          ...original,
          id: "foreign_only",
          createdAt: tx.now,
          updatedAt: tx.now,
        });
      });
      await assert.rejects(
        f.useCases.create(f.actor, {
          ...f.input,
          sources: [{ ...f.input.sources[0], sourceId: "foreign_only" }],
        }),
        { code: "not_found" },
      );
      assert.equal(await f.useCases.get(f.actor, f.input), undefined);
    } finally {
      await f.dispose();
    }
  },
);
