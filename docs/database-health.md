# Database health snapshot verification

Both adapters read the existing foundational workspace and work tables. No new migration is required. The read-only transaction sets the host's tenant context and explicitly filters every queue by that same identifier. A nonexistent workspace fails instead of appearing to have empty, healthy queues.

The database timestamp and all queue minima come from one SQL snapshot. Due pending and running rows count until they settle; future and terminal rows do not. Paging jobs have their own tighter limit. Only watchdog job kinds are excluded from general job lag; outbox work is never excluded by that rule.

Standalone reads bound checkout to one second and total work to four seconds. Cancellation destroys an active checkout, while a late pool acquisition is released without running SQL. A reader refuses further checkouts until that underlying acquisition settles, preventing cancelled requests from accumulating in the pool queue. Dashboard reads use Prisma's one-second acquisition and four-second transaction limits. Its driver does not expose per-query cancellation here; the health checker suppresses the result after abort and coalesces requests until the outstanding read settles. Both readers bound individual SQL statements to one second and lock waits to half a second. Errors returned by these adapters contain no SQL or connection details.

## Opt-in PostgreSQL procedure

Use an existing disposable database, with distinct migration and restricted non-BYPASSRLS application roles. Never point the checks at production. The existing fixtures create and remove a random test schema and reject unsafe role configurations.

Standalone: configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`, then run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test`.

Dashboard: configure `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL`, then run `pnpm --filter @bitsentry/backend exec prisma generate` and `pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand` after building package exports.

The identical five-case suite verifies scope isolation, missing workspaces, overdue readiness, running-work age, future/terminal exclusion and watchdog recovery. These cases are delivered but not runtime-verified in this environment because no disposable database is configured. Unit cases cover adapter cancellation, redaction and transaction cleanup without starting infrastructure.

These readers alone do not activate host routes. Authenticated readiness, lifecycle wiring and outbound watchdog registration follow in the next stack part. Live endpoint and external heartbeat checks require the later operator procedure.
