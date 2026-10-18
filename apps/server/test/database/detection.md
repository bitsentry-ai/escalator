# Standalone detection persistence verification

Migration `0007_detection.sql` adds explicit service/environment policy bindings,
serialized alert groups, source/fingerprint watermarks and immutable processing
receipts. The repository composes existing configuration, signal, page, job and
audit primitives on one PostgreSQL connection. It does not register runtime jobs.

Group creation uses a transaction advisory lock on a namespace, workspace and
group digest. Hash collisions only serialize unrelated groups; they cannot make
rows visible across workspace predicates or forced RLS. All callers acquire the
source lock before a group lock and page locks before the work claim.

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test` with the
existing disposable test configuration (`ESCALATOR_TEST_MIGRATION_DATABASE_URL`
and `ESCALATOR_TEST_DATABASE_URL`) to execute the shared five-case conformance
suite plus populated-table RLS, immutable-receipt privilege and binding CAS tests.
The fixture creates an isolated schema, checks a restricted application role,
reapplies migrations without changing the journal and cleans up the schema.
Never use the application `DATABASE_URL` as an implicit test database.

Without both test variables, those seven cases explicitly skip. SQL call-shape
unit coverage does not prove PostgreSQL syntax, locking, RLS or migration behavior.
No database was configured or started during implementation; runtime proof is
outstanding. Both host runtime registrations follow in the next stack layer.
