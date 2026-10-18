# Standalone probe persistence verification

Migration `0008_probes.sql` adds scoped probe configuration, immutable observations,
threshold state and schedule pointers. One source owns one probe. The repository
composes signal, job and audit writes on the same PostgreSQL connection; HTTP is
performed outside these transactions. Runtime activation follows separately.

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test` with
`ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` pointing
to the same disposable database with separate migration and restricted application
roles. The existing fixture creates an isolated schema, checks that the application
role cannot bypass RLS, applies and reapplies migrations, grants observations only
SELECT/INSERT, and removes its schema when finished. Never substitute the normal
application `DATABASE_URL`.

The seven shared conformance cases check scoped data, concurrent edits, source
ownership, immutable observations, canonical schedules and transaction rollback.
An additional populated-table test checks forced RLS and observation update denial.
These eight cases skip explicitly without both test variables. The SQL binding unit
test is not proof of database syntax, constraints, locking or RLS.

No PostgreSQL test configuration was supplied. No database or server was started,
and migration/concurrency behavior remains not runtime-verified.

The shared capacity race is registered in this layer and requires the same
explicit test database configuration. It is not runtime-verified here.
