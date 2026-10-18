import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  migrate,
  type Migration,
} from "../../src/platform/database/migrate.js";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";

/** Opt-in only. Never fall back to the application's DATABASE_URL. */
export function testDatabaseConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const admin = environment.ESCALATOR_TEST_MIGRATION_DATABASE_URL;
  const app = environment.ESCALATOR_TEST_DATABASE_URL;
  if (Boolean(admin) !== Boolean(app))
    throw new Error(
      "Configure both Escalator test database variables or neither",
    );
  return Boolean(admin && app);
}
/** node-postgres URL options override Pool options: put the random scope in the URL. */
export function scopedTestUrl(value: string, schema: string): string {
  if (!/^escalator_test_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid test schema");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Expected a PostgreSQL URL");
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function postgresFixture(migrations: readonly Migration[]) {
  if (!testDatabaseConfigured())
    throw new Error("No explicitly configured Escalator test database");
  const schema = `escalator_test_${randomUUID().replaceAll("-", "")}`;
  const migrationUrl = process.env.ESCALATOR_TEST_MIGRATION_DATABASE_URL!;
  const appUrl = process.env.ESCALATOR_TEST_DATABASE_URL!;
  // Random, internally generated schema; connection options never interpolate user input.
  const admin = new Pool({
    connectionString: scopedTestUrl(migrationUrl, schema),
    connectionTimeoutMillis: 5000,
  });
  const app = new Pool({
    connectionString: scopedTestUrl(appUrl, schema),
    connectionTimeoutMillis: 5000,
  });
  let created = false;
  try {
    const role = await app.query<{
      role: string;
      bypass: boolean;
      superuser: boolean;
      database: string;
    }>(
      "SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS superuser, current_database() AS database FROM pg_roles WHERE rolname = current_user",
    );
    const current = role.rows[0];
    const owner = await admin.query<{ role: string; database: string }>(
      "SELECT current_user AS role, current_database() AS database",
    );
    const membership = await app.query<{ member: boolean }>(
      "SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member",
      [owner.rows[0].role],
    );
    if (
      membership.rows[0].member ||
      current.bypass ||
      current.superuser ||
      current.role === owner.rows[0].role ||
      current.database !== owner.rows[0].database
    ) {
      throw new Error(
        "Conformance requires distinct migration and restricted non-BYPASSRLS application roles on the same disposable database",
      );
    }
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`);
    created = true;
    console.info(`Escalator disposable test schema: ${schema}`);
    await migrate(admin, migrations);
    // Rerunning identical migrations must succeed without changing the journal.
    const before = await admin.query(
      "SELECT name, checksum, applied_at FROM escalator_migration ORDER BY name",
    );
    await migrate(admin, migrations);
    const after = await admin.query(
      "SELECT name, checksum, applied_at FROM escalator_migration ORDER BY name",
    );
    if (JSON.stringify(before.rows) !== JSON.stringify(after.rows))
      throw new Error("Migration rerun changed the journal");
    await admin.query(
      `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(current.role)}`,
    );
    for (const table of [
      "escalator_workspace",
      "escalator_service",
      "escalator_environment",
      "escalator_responder",
      "escalator_audit",
    ]) {
      await admin.query(
        `GRANT SELECT, INSERT ON ${identifier(table)} TO ${identifier(current.role)}`,
      );
    }
    // Ensure both URLs reach this exact schema, not separate servers with equal database names.
    await app.query("SELECT id FROM escalator_workspace LIMIT 0");
    return {
      repository: new PostgresFoundationRepository(app),
      app,
      async dispose() {
        try {
          await app.end();
        } finally {
          try {
            await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      await app.end();
    } finally {
      try {
        if (created)
          await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
    throw error;
  }
}
