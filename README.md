# Escalator workspace

Independent self-hosted workspace and the canonical shared feature package.
Copy this directory alone, then run:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
```

Requires Node 22.12+ and pnpm 10.32.1. No root checkout, Desktop CE,
WorkOS, Encore, database, or server process is required for these checks.
The server exports an app factory with local authentication; see
[authentication configuration and operator procedures](docs/authentication.md).
Importing the factory never starts a listener.
For deployment, follow the [isolated installation guide](docs/install/README.md)
and [backup/upgrade procedures](docs/operations.md).
The package exports compiled CommonJS and ESM only. React is a peer dependency.

## Mounted secret keys

Before constructing the server app, set `ESCALATOR_SECRET_KEY_FILE` to an absolute
path to a private JSON file mounted outside the PostgreSQL volume. Startup fails
when the file is missing, malformed or accessible to other users. The file has
this shape; each key value is a freshly generated 32-byte key encoded as standard
base64, not a password:

```json
{
  "version": 1,
  "activeKeyId": "key-2026-09",
  "keys": { "key-2026-09": "<32 random bytes, base64>" }
}
```

Generate a real key file on the operator's machine without printing its content:

```sh
node -e 'const fs=require("node:fs"),c=require("node:crypto");fs.writeFileSync(process.argv[1],JSON.stringify({version:1,activeKeyId:"key-2026-09",keys:{"key-2026-09":c.randomBytes(32).toString("base64")}}),{mode:0o600,flag:"wx"})' /secure/escalator-keys.json
```

Mount it read-only with mode `0400` or `0600`. Keep a separately protected backup
of every key needed by a database backup. Losing those keys makes the encrypted
secrets unrecoverable. Never commit keys, put them in database rows, or pass their
values as command arguments. Key IDs and opaque secret IDs are safe metadata;
credential values are not.

Secret values use versioned AES-256-GCM envelopes with fresh 96-bit random nonces
and 128-bit authentication tags. Authentication binds the workspace, secret ID
and key ID. Durable work contains approved opaque `secretIds` only. The host
loads that allowlist and the current lease from PostgreSQL before releasing
bytes to a trusted adapter. Incoming webhook bodies and model output must never
populate this authorization field directly. Completion, cancellation, expiry,
revocation or a different scope prevents a new read.

Owned plaintext buffers are cleared after the callback, including failure paths.
JavaScript strings and SDK/HTTP copies cannot be guaranteed erased. Do not return
plaintext from callbacks, include it in errors, or log request bodies. This is
bounded use and best-effort cleanup, not a claim of physical memory erasure.

### Rotation and restore

1. Back up PostgreSQL and the matching key file separately. Add a new random key
   under a new ID while retaining every old key. Keep the old active ID until
   every instance has loaded the expanded key set.
2. Change `activeKeyId` to the new ID and reload all instances. New writes now use
   it; existing ciphertext remains readable through the retained keys.
3. In a maintenance window, from this workspace directory, build and run the scoped rotation
   command with `ESCALATOR_DATABASE_URL`, `ESCALATOR_WORKSPACE_ID`, and
   `ESCALATOR_SECRET_KEY_FILE` explicitly configured:

   ```sh
   pnpm --filter @bitsentry-escalator/server secrets:rotate
   ```

   The command uses at most two database connections and batches of 50 rows.
   Revision checks preserve concurrent edits. A nonzero remaining count or failed
   run requires another run; do not remove old keys. Each successful rewrite is
   audited as the local key-rotation operator, with no credential values.

4. Only after all rows have been rewritten, all instances use the new key, and
   eight hours have elapsed since the signing-key switch may old keys leave the
   live key file without invalidating older session cookies. Retain them in
   protected historical backups for as long as any database backup references them.
5. Restore a database together with its matching key set. Verify secret access
   and pending paging state in an isolated environment before accepting traffic.
   Never substitute a freshly generated key for a lost historical key.

To run database scenarios, configure
both `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`
with different migration and restricted application roles on one disposable
database, then run `pnpm --filter @bitsentry-escalator/server test`. Fixtures use
random temporary schemas and remove them afterward; absent variables explicitly
skip the database scenarios. The application role must not be a superuser,
BYPASSRLS, or a member of the migration role. Never use a database containing real
records. The CI workflow runs both hosts' conformance suites with disposable roles.
Dashboard uses the separate secret-store broker; it does not use this key file.

Before relying on paging, complete the [installation checks](docs/install/README.md)
and [capacity measurement procedure](docs/capacity.md). No production capacity envelope
is claimed until those runtime measurements are recorded.
