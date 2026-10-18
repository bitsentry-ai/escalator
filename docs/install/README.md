# Isolated Escalator installation

The build context is `apps/escalator`, which may be copied out of the monorepo.
The deployment consists of one app image and PostgreSQL. It does not need the root
workspace, Desktop CE, WorkOS, Encore or Redis. Build the image from the reviewed
commit and record its digest rather than relying on a mutable local tag.

## Prepare private state

Create private `secrets` and `operator` directories outside version control and
back them up independently of the database. Create three distinct high-entropy
password files: `postgres-password`, `migrator-password`, `app-password`. Avoid
shell tracing, command-line credential values and terminal output of secrets.
The PostgreSQL image needs these files readable by UID 999. Use owner-only file
permissions and verify ownership on the actual host; default Compose secret
permissions are not adequate for the encryption key.

The keyring is version-1 JSON with `activeKeyId` and a `keys` map of key identifiers
to base64-encoded, random 32-byte keys. Generate it with a cryptographic random
source, write it exclusively with mode 0600, and never overwrite an existing key
on upgrade. For example, from a private setup directory using Node:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const ring = { version: 1, activeKeyId: 'initial', keys: { initial: randomBytes(32).toString('base64') } };
writeFileSync('secrets/keyring.json', JSON.stringify(ring) + '\n', { flag: 'wx', mode: 0o600 });
JS
```

Make the mounted key file readable by UID 1000 with mode 0400 or 0600, and make the
operator directory writable only by that UID. Keep a secure operator recovery
copy. Do not reuse the database administrator password as a master key.

Create private `app.env` with these names; obtain actual values from private local
configuration, never from a committed example:

```dotenv
ESCALATOR_WORKSPACE_ID=your-stable-workspace-id
ESCALATOR_WORKSPACE_NAME=Your team
ESCALATOR_PUBLIC_URL=https://oncall.example.com
ESCALATOR_TRUST_PROXY_HOPS=1
ESCALATOR_DATABASE_URL=postgresql://escalator_app:URL_ENCODED_PASSWORD@postgres:5432/escalator
```

The public origin must match the TLS endpoint. Set proxy hops to the actual trusted
path; the composition's localhost port is not a public TLS endpoint. A local-only
rehearsal may use its exact loopback origin. Preserve the workspace ID on upgrades.
The composition supplies key/output-file paths and port 3000. Additional provider,
readiness and watchdog configuration is described in the feature setup docs.

## Database, grants and bootstrap

From the standalone workspace, after reviewing secrets and mounts:

```sh
docker compose build app
docker compose up -d postgres
```

An empty PostgreSQL volume runs `deploy/roles.sh` once. It creates the restricted
application role and a separate migration role; it does not create app tables.
Existing volumes are never reinitialized. Prepare
`ESCALATOR_MIGRATION_DATABASE_URL` privately for `escalator_migrate` on the same
Compose database, then pass the variable name without its value in the command:

```sh
docker compose run --rm --no-deps -e ESCALATOR_MIGRATION_DATABASE_URL app \
  node apps/server/dist/platform/database/migrate-cli.js
docker compose exec -T postgres psql -U escalator_migrate -d escalator \
  -v app_role=escalator_app < deploy/runtime-grants.sql
docker compose run --rm --no-deps app \
  node apps/server/dist/platform/auth/operator-cli.js bootstrap
```

The migration role needs the privileges specified by the supplied role setup,
including RLS bypass for existing cross-workspace migration backfills. Never use
it for normal app connections. The grant script refuses privileged or owning
application roles. Review existing grants when upgrading a non-fresh role.

Bootstrap creates a one-use grant in the private operator file, valid for fifteen
minutes. Read it through your authorized local operator channel, enter it in the
setup screen, and remove the consumed file. Do not paste it into logs or tickets.
An existing output file is intentionally not overwritten. See the authentication
procedure for local account recovery instead of repeating bootstrap.

Start the app only after these operations succeed:

```sh
docker compose up -d app
```

## Verification before relying on paging

Record operator, platform version, image digest, migration ledger and date. Verify
login/MFA, service configuration and a designated test incident. Exercise its
channel delivery and one-tap acknowledgement, and verify remaining escalation
steps stop. Check that unrelated or expired acknowledgement tokens fail.

Configure authenticated readiness and an independent watchdog. Confirm database
loss or a stalled dispatcher makes readiness fail while process liveness can stay 200. Confirm the watchdog alerts when Escalator stops. Rehearse database plus key
restore and safe pending-page handoff using the operations procedure. Record skips
as unverified; a green container health check is not proof of operational readiness.
