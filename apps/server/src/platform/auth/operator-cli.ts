import { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import { PostgresAccountSecurity } from "./account-security.repository.js";
import { loadSecretKeys } from "../secrets/secrets.module.js";
import { writeOperatorGrant } from "./operator-grant.js";
async function main() {
  const [command, login] = process.argv.slice(2);
  if (
    process.argv.length > 4 ||
    !["bootstrap", "recover"].includes(command) ||
    (command === "bootstrap" && login) ||
    (command === "recover" && !login)
  )
    throw new Error("Invalid command");
  const workspaceId = workspaceIdSchema.parse(
    process.env.ESCALATOR_WORKSPACE_ID,
  );
  const connectionString = process.env.ESCALATOR_DATABASE_URL;
  const output = process.env.ESCALATOR_AUTH_GRANT_FILE;
  if (!connectionString || !output)
    throw new Error("Missing operator configuration");
  const keys = loadSecretKeys(process.env);
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const auth = new PostgresAccountSecurity(pool, workspaceId, keys);
    await writeOperatorGrant(output, async (digest) => {
      if (command === "bootstrap")
        await auth.bootstrap(
          process.env.ESCALATOR_WORKSPACE_NAME ?? "Escalator",
          digest,
          new Date(Date.now() + 15 * 60000),
        );
      else {
        const account = await auth.findByLogin(login);
        if (!account?.enabled) throw new Error("Account unavailable");
        await auth.issueRecovery(account.id, digest);
      }
    });
    console.info(
      "One-use grant written to the configured private file. Valid for 15 minutes; remove the file after use.",
    );
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(() => {
    console.error(
      "Unable to issue local authentication grant. Check the command, workspace, database, mounted keys and an unused private output path.",
    );
    process.exitCode = 1;
  });
