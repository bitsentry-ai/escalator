import { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { loadSecretKeys } from "./secrets.module.js";
import {
  PostgresSecretWriter,
  SecretRotationOperator,
} from "./postgres-secret.writer.js";
import { rotateKeys } from "./rotate-keys.js";
async function main() {
  const keys = loadSecretKeys(process.env);
  const workspaceId = workspaceIdSchema.parse(
    process.env.ESCALATOR_WORKSPACE_ID,
  );
  const connectionString = process.env.ESCALATOR_DATABASE_URL;
  if (!connectionString) throw new Error("ESCALATOR_DATABASE_URL is required");
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const writer = new PostgresSecretWriter(pool, keys);
    const operator = new SecretRotationOperator(workspaceId);
    const result = await rotateKeys((after) =>
      writer.rotateBatch(operator, after),
    );
    console.info(JSON.stringify(result));
    if (result.remaining !== 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
if (require.main === module) {
  void main().catch(() => {
    console.error(
      "Secret key rotation failed. Check mounted keys, workspace and database configuration; retry with all historical keys retained.",
    );
    process.exitCode = 1;
  });
}
