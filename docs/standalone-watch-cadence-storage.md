# Standalone watch cadence persistence

Migration `0020_watch_cadence.sql` adds one current ownership row per probe and an immutable receipt per deployment/probe. Composite foreign keys bind the probe, source, target, service, environment and owning deployment to the same workspace. Forced row security scopes reads and writes; application receipts have no update/delete policy.

`PostgresWatchCadenceRepository` composes probe, signal, deployment, paging, baseline, watch and cadence ports on one physical connection and transaction guard. Deployment and signal token ports remain separate. This adapter is not registered in the running application yet; Dashboard parity and worker-budget accounting precede activation.

The probe's capacity/target/source locks serialize ownership. Compare-and-swap updates require the expected revision and generation. Ownership deletion is fenced by both; immutable receipts survive deletion to prevent retrying an old application after an operator edit. Lease updates preserve the original interval and applied probe version.

## Database verification procedure

No disposable database is configured in this environment. These checks are delivered but **not runtime-verified**. They never fall back to the application `DATABASE_URL` and do not start PostgreSQL.

1. On an already provisioned disposable PostgreSQL database, configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`. The latter must be a distinct restricted role without superuser/BYPASSRLS privileges or membership in the migration role.
2. Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test`. Fixtures create randomly named schemas, apply the complete immutable migration sequence twice, grant scoped privileges, and remove their schema afterward.
3. Confirm the cadence cases ran rather than skipped: concurrent duplicate application and fresh-adapter read, whole-transaction rollback followed by retry, foreign-workspace invisibility and receipt immutability.
4. Retain the test output. Any connection failure or partially configured environment fails the suite; it is not treated as a pass.

Shared in-memory scenarios cover overlapping deadlines, restoration and manual-edit preservation. PostgreSQL time/locking behavior and real probe execution still require an equipped environment. No live provider requests occur in the persistence suite.
