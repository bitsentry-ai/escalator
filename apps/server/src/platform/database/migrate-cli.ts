import { resolve } from "node:path";
import { Pool } from "pg";
import { migrate, readMigrations } from "./migrate.js";

/** Production migration command; importing this module never connects. */
export async function runMigrations(
  connectionString: string | undefined = process.env
    .ESCALATOR_MIGRATION_DATABASE_URL,
  directory = resolve(__dirname, "../../../migrations"),
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      "Set ESCALATOR_MIGRATION_DATABASE_URL for the migration role",
    );
  }
  const migrations = await readMigrations(directory);
  if (migrations.length === 0) throw new Error("No Escalator migrations found");
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    await migrate(pool, migrations);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runMigrations().then(
    () => {
      console.log("Escalator migrations applied");
    },
    () => {
      // Driver errors can contain connection details; do not print the URL/cause.
      console.error(
        "Escalator migration failed. Check the migration connection, privileges, files and history.",
      );
      process.exitCode = 1;
    },
  );
}
