# Database health snapshots

Both adapters read the existing foundational workspace and work tables. The compatibility migration (`0032_compatibility.sql` and the Dashboard companion) is now required. Each bounded read validates package/adapter metadata before querying queues; missing or incompatible metadata fails readiness. The read-only transaction sets the host's tenant context and explicitly filters every queue by that same identifier. A nonexistent workspace fails instead of appearing to have empty, healthy queues.

The database timestamp and all queue minima come from one SQL snapshot. Due pending and running rows count until they settle; future and terminal rows do not. Paging jobs have their own tighter limit. Only watchdog job kinds are excluded from general job lag; outbox work is never excluded by that rule.

Standalone reads bound checkout to one second and total work to four seconds. Cancellation destroys an active checkout, while a late pool acquisition is released without running SQL. A reader refuses further checkouts until that underlying acquisition settles, preventing cancelled requests from accumulating in the pool queue. Dashboard reads use Prisma's one-second acquisition and four-second transaction limits. Its driver does not expose per-query cancellation here; the health checker suppresses the result after abort and coalesces requests until the outstanding read settles. Both readers bound individual SQL statements to one second and lock waits to half a second. Errors returned by these adapters contain no SQL or connection details.

## Opt-in PostgreSQL procedure

Use an existing disposable database, with distinct migration and restricted non-BYPASSRLS application roles. Never point the checks at production. The existing fixtures create and remove a random test schema and reject unsafe role configurations.

Standalone: configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`, then run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test`.

Dashboard: configure `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL`, then run `pnpm --filter @bitsentry/backend exec prisma generate` and `pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand` after building package exports.

Both hosts register these readers with authenticated readiness and the actual scheduler lifecycle. See [operational-health-setup.md](operational-health-setup.md) for configuration and endpoint/watchdog checks.
