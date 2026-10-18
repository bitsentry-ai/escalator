# Standalone heartbeat database checks

Run only against an existing disposable PostgreSQL database. Set `ESCALATOR_TEST_MIGRATION_DATABASE_URL` for the schema-creating migration role and `ESCALATOR_TEST_DATABASE_URL` for a separate non-owner, non-superuser, non-BYPASSRLS application role. The harness never falls back to `DATABASE_URL` and creates a random test schema, not a server or database service.

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features build
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
```

Without both variables the four shared heartbeat conformance cases and one populated-table RLS/receipt-privilege case are explicitly skipped. SQL binding/lock tests run without PostgreSQL. No test database was supplied for this implementation; the live cases are not runtime-verified.

The application role needs SELECT/INSERT/UPDATE on heartbeat configuration, state and grant tables; immutable receipt rows receive SELECT/INSERT only. Source, durable-job and audit privileges follow the existing signal/foundation guides. A hash-only SELECT policy supports pre-authentication routing; the adapter then rechecks a grant under the source/heartbeat locks. Never grant the application role table ownership or BYPASSRLS.

The conformance suite checks duplicate ping receipts, trusted scope, revocation, closed/poisoned handles, prohibited recovery writes and rollback of configuration or complete ping work. The additional test populates all four tables, verifies empty/foreign contexts cannot read them and verifies receipt UPDATE is denied. Migrations are rerun by the harness to check journal idempotency. Fixtures clean up their random schema; an interrupted run prints its generated schema name for operator cleanup.

These adapters do not expose a heartbeat endpoint or activate its scheduler yet. The following host integration layer supplies those application entry points.
