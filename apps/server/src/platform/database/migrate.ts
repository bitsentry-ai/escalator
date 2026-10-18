import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export interface Migration {
  name: string;
  sql: string;
}

export async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error("Invalid Escalator migration filename");
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
}

/** Migration credentials are separate from the application's restricted role.
 * A single transaction serializes bootstrap and rolls back both DDL and journal.
 */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[],
): Promise<void> {
  const names = migrations.map(({ name }) => name);
  if (
    new Set(names).size !== names.length ||
    [...names].sort().some((name, i) => name !== names[i])
  ) {
    throw new Error("Escalator migrations must have unique ascending names");
  }
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(18672103, 1)");
    await connection.query(`CREATE TABLE IF NOT EXISTS escalator_migration (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )`);
    const applied = await connection.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM escalator_migration ORDER BY name",
    );
    for (let index = 0; index < applied.rows.length; index++) {
      const row = applied.rows[index];
      const migration = migrations[index];
      if (
        !migration ||
        migration.name !== row.name ||
        digest(migration.sql) !== row.checksum
      ) {
        throw new Error(
          `Escalator migration history differs at ${row.name}; restore the matching application version`,
        );
      }
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await connection.query(migration.sql);
      await connection.query(
        "INSERT INTO escalator_migration (name, checksum) VALUES ($1, $2)",
        [migration.name, digest(migration.sql)],
      );
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
function digest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}
