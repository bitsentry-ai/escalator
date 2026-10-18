# Paging failure verification

The shared suite in `packages/features/test/scenarios/paging/` runs unchanged
through the memory store, standalone PostgreSQL and Dashboard Prisma adapters.
Host tests reuse the existing disposable-schema fixtures and restricted application
roles. No test uses the application's `DATABASE_URL` as a fallback.

| Scenario                                | Committed state checked                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Restart after outbox commit             | A new repository/dispatcher consumes the stored intent, retains one accepted attempt and receipt, and does not resend a settled claim. |
| Duplicate acknowledgement after restart | First owner, timestamp and revision stay fixed; acknowledgement cancels the outstanding send claim.                                    |
| Duplicate provider receipt work         | Replayed receipt work keeps the first owner/timestamp/revision and cannot repeat the provider request.                                 |
| Permanent provider failure              | The failed attempt and non-retryable result persist; the page remains open.                                                            |
| Provider accepted but response lost     | The attempt records `unknown`, the work result requests retry, and the original durable intent remains deduplicated.                   |
| Downtime through terminal deadline      | Obsolete steps are skipped, unavailable terminal recipients are recorded, and the page is exhausted without resolving the incident.    |

These fixtures simulate interruption boundaries and provider results in unit tests;
they do not kill a server or call a real provider. Existing conformance tests also
cover rollback, concurrent acknowledgement, expired lease fencing, and independent
observation of committed work claims. `unknown` is deliberately distinct from
confirmed rejection or successful delivery. Remote delivery is not exactly once.

## Commands

From the repository root, first build the shared package:

```sh
pnpm run escalator:build:packages
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

For the standalone PostgreSQL cases, an operator must configure both
`ESCALATOR_TEST_DATABASE_URL` and `ESCALATOR_TEST_MIGRATION_DATABASE_URL`.
For Dashboard cases, configure both `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` and
`ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL`. Use the existing fixture
requirements: a disposable database, separate migration and application roles,
no superuser/BYPASSRLS for the application role, and no application-role membership
in the migration role. The fixtures create a random schema, apply migrations,
grant restricted access, and remove that schema in cleanup. Do not point them at
an application database or paste connection strings into reports.

With neither pair configured, host suites explicitly skip the PostgreSQL cases.
With only one variable of a pair configured, they fail configuration validation.
Run both host commands with their respective pairs, retain the test summaries,
and verify all six named failure cases passed rather than skipped. A passed
memory suite does not establish PostgreSQL behavior, migration upgrades, process
kill recovery, or provider delivery.

## Runtime evidence still required

No disposable test database was available during implementation. PostgreSQL
execution is therefore not runtime-verified. Docker/Encore image inclusion,
real process termination, live provider acknowledgements and capacity measurements
require the documented environment and separate permitted execution. This suite
supplies reproducible cases; it does not substitute for those operational checks.
