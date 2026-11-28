# Escalator

BitSentry's self-hosted on-call service: it turns monitoring signals into incidents and pages responders through escalation policies. Its own pnpm workspace, lockfile and PostgreSQL database.

## Hard stops

- Never run the server or its `db:migrate`, `secrets:rotate` or `auth:operator` scripts against a database that holds real records.
- Never print or commit a keyring, `app.env`, `secrets/`, `operator/` or a backup, and never overwrite an existing one. Tests use temporary key material. A new key cannot decrypt old records.
- Never send a real page: no real contacts, mail servers, Pushover accounts or webhooks. Exercise POST probes only against a disposable endpoint with idempotency support and tested cleanup.
- Never delete paging rows, mark work delivered or cancel pages to empty a queue or make a test pass.
- Do not start the server, `vite` or `compose.yaml` unless asked. Never push to `main`.
- In the monorepo this is the `apps/escalator` submodule. Change Escalator here, then bump the pointer there.

## Verify

`.github/workflows/quality.yml` runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` (ESLint, `scripts/check-boundaries.mjs`, `scripts/check-locales.mjs`), `pnpm -r test`, `node --test scripts/*.test.mjs` and `pnpm i18n:audit:integrity`; `knip.yml` runs `pnpm knip`. Also run `pnpm run build`.

PostgreSQL scenarios skip when `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` are both unset, and fail when only one is set. To run them, point both at one disposable database with separate migration and restricted app roles, as `quality.yml` does. Persistence, locking and isolation changes need them.

## Constraints

- Paging must never be silently lost. A missing schedule or contact is an explicit uncovered step, and a possible duplicate beats a missed page. See `docs/paging-dispatch.md`.
- Durable work carries opaque secret IDs, never values. No plaintext secrets in errors, logs or command arguments.
- Every read and write of tenant data is scoped to the authenticated workspace. The runtime role runs under row-level security and never owns tables: new tables and `FOR UPDATE`/`FOR SHARE` reads need grants in `deploy/runtime-grants.sql`.
- Schema changes are a new `NNNN_lowercase_name.sql` in `apps/server/migrations`. Never edit an applied one; the migrator checks checksums.
- `packages/features` stays host-neutral; `scripts/check-boundaries.mjs` holds the import rules.
- Strings go in every full locale under `packages/features/src/locales`; `en-GB` and `en-AU` hold regional overrides only.

## Commits and PRs

- Lowercase conventional subjects for commits and PR titles: `fix(paging): keep frozen recipients after a reclaim`.
- Open PRs as drafts, with the body from `.github/pull_request_template.md`. Follow its rules except one: agents do not request reviewers or assign people.
- No `Co-Authored-By` lines or AI attribution.
