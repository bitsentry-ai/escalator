import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { configurationConformance } from "@escalator-test/configuration";
import { seedPagingFixture } from "@escalator-test/paging";
import {
  workspaceIdSchema,
  responderIdSchema,
  scheduleSchema,
  schedulePreviewSchema,
  configuredPolicySchema,
  configuredContactSchema,
  availabilitySchema,
} from "@bitsentry-escalator/features/contracts";
import { previewSchedule } from "@bitsentry-escalator/features/application";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresSecretWriter } from "../../src/platform/secrets/postgres-secret.writer.js";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
const options = testDatabaseConfigured()
  ? {}
  : {
      skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
    };
const create = async () =>
  postgresFixture(await readMigrations(resolve("migrations")));
configurationConformance(
  "standalone PostgreSQL configuration",
  async () => {
    const fixture = await create();
    return {
      repository: new PostgresConfigurationRepository(fixture.app),
      dispose: () => fixture.dispose(),
    };
  },
  options,
);

test(
  "configuration RLS scopes every populated table and contacts accept only provider secrets",
  options,
  async () => {
    const fixture = await create();
    try {
      const scope = workspaceIdSchema.parse("configuration_rls");
      const repo = new PostgresConfigurationRepository(fixture.app);
      await repo.transaction(scope, seedPagingFixture);
      const keys = SecretKeyRing.parse({
        version: 1,
        activeKeyId: "fixture",
        keys: { fixture: Buffer.alloc(32, 1).toString("base64") },
      });
      const writer = new PostgresSecretWriter(fixture.app, keys);
      const secret = await writer.create(
        {
          workspaceId: scope,
          responderId: responderIdSchema.parse("primary"),
          role: "administrator",
        },
        "provider",
        Buffer.from("fixture"),
      );
      await repo.transaction(scope, async (tx) => {
        const schedule = scheduleSchema.parse({
          id: "primary",
          workspaceId: scope,
          serviceId: "api",
          name: "Primary",
          version: 1,
          enabled: true,
          rotations: [],
          overrides: [],
        });
        await tx.configuration.schedules.put(schedule, null);
        const startsAt = new Date(tx.now).toISOString();
        const endsAt = new Date(Date.parse(startsAt) + 86400000).toISOString();
        const preview = schedulePreviewSchema.parse({
          id: "preview",
          workspaceId: scope,
          scheduleId: schedule.id,
          serviceId: schedule.serviceId,
          scheduleVersion: 1,
          createdAt: tx.now,
          startsAt,
          endsAt,
          intervals: previewSchedule(schedule, startsAt, endsAt),
        });
        await tx.configuration.previews.insert(preview);
        const policy = configuredPolicySchema.parse({
          ...(await tx.pages.get("page"))!.policy,
          peerScheduleId: schedule.id,
          enabled: true,
          primaryPreviewId: preview.id,
          peerPreviewId: preview.id,
        });
        await tx.configuration.policies.put(policy, null);
        await tx.configuration.contacts.put(
          configuredContactSchema.parse({
            id: "contact",
            workspaceId: scope,
            responderId: "primary",
            secretId: secret.id,
            version: 1,
            channel: "webhook",
            enabled: true,
            priority: 0,
          }),
          null,
        );
        await tx.configuration.availability.put(
          availabilitySchema.parse({
            id: "primary",
            workspaceId: scope,
            version: 1,
            timeZone: "UTC",
            windows: [],
          }),
          null,
        );
      });
      for (const table of [
        "escalator_schedule",
        "escalator_policy",
        "escalator_contact",
        "escalator_availability",
        "escalator_schedule_preview",
      ])
        assert.deepEqual(
          (await fixture.app.query(`SELECT id FROM ${table}`)).rows,
          [],
        );
      const connection = await fixture.app.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id', $1, true)",
          [scope],
        );
        await connection.query(
          "UPDATE escalator_secret SET purpose='authentication' WHERE workspace_id=$1 AND id=$2",
          [scope, secret.id],
        );
        await connection.query("COMMIT");
        await assert.rejects(
          repo.transaction(scope, async (tx) => {
            const contact = (await tx.configuration.contacts.get("contact"))!;
            await tx.configuration.contacts.put({ ...contact, version: 2 }, 1);
          }),
          /not_found/,
        );
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.workspace_id', 'foreign', true)",
        );
        const value = await repo.transaction(scope, (tx) =>
          tx.configuration.availability.get(responderIdSchema.parse("primary")),
        );
        const data = Object.fromEntries(
          Object.entries(value!).filter(([key]) => key !== "workspaceId"),
        );
        await assert.rejects(
          connection.query(
            "INSERT INTO escalator_availability(workspace_id,id,data,version) VALUES ($1,'primary',$2,1)",
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
