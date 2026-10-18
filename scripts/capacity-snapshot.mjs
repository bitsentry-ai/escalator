import process from "node:process";
import { error as logError } from "node:console";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Operator-only diagnostic. It never starts an application or creates infrastructure. */
export function capacityConfiguration(environment) {
  if (environment.ESCALATOR_CAPACITY_DISPOSABLE !== "1")
    throw new Error("Explicit disposable capacity environment required");
  const host = environment.ESCALATOR_CAPACITY_HOST;
  if (host !== "standalone" && host !== "dashboard")
    throw new Error("Invalid host");
  const scope = environment.ESCALATOR_CAPACITY_WORKSPACE_ID;
  if (!scope || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope))
    throw new Error("Invalid workspace");
  const connectionString = environment.ESCALATOR_CAPACITY_DATABASE_URL;
  const output = environment.ESCALATOR_CAPACITY_OUTPUT;
  if (!connectionString || !output || !isAbsolute(output))
    throw new Error("Missing capacity configuration");
  return { host, scope, connectionString, output };
}
export async function readCapacitySnapshot(db, configuration) {
  const column =
    configuration.host === "standalone" ? "workspace_id" : "organization_id";
  const setting =
    configuration.host === "standalone"
      ? "app.workspace_id"
      : "app.organization_id";
  await db.query("BEGIN READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '2s'");
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SELECT set_config($1,$2,true)", [
      setting,
      configuration.scope,
    ]);
    const identity = await db.query(
      "SELECT r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user",
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0].rolsuper ||
      identity.rows[0].rolbypassrls
    )
      throw new Error("Capacity reader must use a restricted role");
    const scope = await db.query(
      `SELECT 1 FROM escalator_workspace WHERE ${configuration.host === "standalone" ? "id" : "organization_id"}=$1`,
      [configuration.scope],
    );
    if (scope.rowCount !== 1) throw new Error("Capacity workspace unavailable");
    const started = await db.query("SELECT clock_timestamp() AS started_at");
    const jobs = await db.query(
      `SELECT kind,state,count(*)::text AS count,
      min(due_at) AS earliest_due_at,
      max(greatest(0,extract(epoch FROM (statement_timestamp()-due_at))*1000)) AS oldest_lag_ms
      FROM escalator_job WHERE ${column}=$1 AND state IN ('pending','running')
      GROUP BY kind,state ORDER BY kind,state LIMIT 1025`,
      [configuration.scope],
    );
    if (jobs.rows.length > 1024)
      throw new Error("Capacity diagnostic kind bound exceeded");
    const outbox = await db.query(
      `SELECT state,count(*)::text AS count,
      min(due_at) AS earliest_due_at,
      max(greatest(0,extract(epoch FROM (statement_timestamp()-due_at))*1000)) AS oldest_lag_ms
      FROM escalator_outbox WHERE ${column}=$1 AND state IN ('pending','running') GROUP BY state ORDER BY state`,
      [configuration.scope],
    );
    const storage =
      await db.query(`SELECT c.relname AS table_name,pg_total_relation_size(c.oid)::text AS total_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relkind='r' AND starts_with(c.relname,'escalator_')
      ORDER BY c.relname LIMIT 257`);
    if (storage.rows.length > 256)
      throw new Error("Capacity diagnostic table bound exceeded");
    const time = await db.query("SELECT clock_timestamp() AS captured_at");
    await db.query("COMMIT");
    return {
      formatVersion: 1,
      host: configuration.host,
      captureStartedAt: started.rows[0].started_at,
      capturedAt: time.rows[0].captured_at,
      consistency: "read_committed_multiple_queries",
      measurement: "diagnostic_snapshot_not_dispatch_latency",
      storageScope: "all_tenants_in_current_schema",
      jobs: jobs.rows,
      outbox: outbox.rows,
      storage: storage.rows,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
export async function main(environment = process.env) {
  const configuration = capacityConfiguration(environment);
  const require = createRequire(
    new URL("../apps/server/package.json", import.meta.url),
  );
  const { Pool } = (await import(pathToFileURL(require.resolve("pg")).href))
    .default;
  const pool = new Pool({
    connectionString: configuration.connectionString,
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  let db;
  try {
    db = await pool.connect();
    const snapshot = await readCapacitySnapshot(db, configuration);
    await writeFile(
      configuration.output,
      JSON.stringify(snapshot, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    if (db) db.release();
    await pool.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch(() => {
    logError(
      "Capacity snapshot failed; verify the disposable database, restricted reader and unused output path.",
    );
    process.exitCode = 1;
  });
}
