# Metric persistence verification

Migration `0010_metrics.sql` adds monitors, immutable configuration versions,
immutable observations and schedule pointers. Runtime roles need SELECT/INSERT
on versions and observations; SELECT/INSERT/UPDATE on monitors and schedules.
Scope policies are forced. A schedule receipt must belong to its exact monitor
and configuration version. Retention requires a separate restricted maintenance
path; this change grants no runtime deletion permission.

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test` with
`ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` configured
for the same disposable database using distinct migration and restricted roles.
Never substitute normal application credentials. The existing fixture creates
and removes its own isolated schema and checks the role cannot bypass RLS.

Five shared conformance cases exercise scoped CAS/version snapshots, immutable
observations, historical visibility, derived verdicts, transaction lifetime and
rollback. An additional populated-table case checks RLS and denied receipt updates.
SQL-binding unit checks run without PostgreSQL and do not prove database behavior.

No disposable database was supplied: PostgreSQL cases skip explicitly. Migration
execution, RLS, FK constraints and concurrency are **not runtime-verified**.
Host management and scheduler activation follow separately.
