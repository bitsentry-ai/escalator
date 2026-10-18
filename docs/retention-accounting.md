# Retention policy storage and payload accounting

Both hosts persist versioned retention settings and transactional byte totals for normalized signal, probe and metric receipt JSON. This part does not activate deletion, maintenance jobs, settings APIs or screens. The budget remains a maintenance target rather than a physical database quota.

The default is 30 elapsed UTC days and 5 GiB of normalized payloads. Deployment ceilings default to 365 days and 5 GiB; hosts can supply other validated ceilings during activation. Administrators can save policies within those ceilings. Reads return the saved policy and the effective, potentially clamped settings separately, so lowering a deployment ceiling never silently rewrites the saved revision. Concurrent edits use compare-and-swap, and an audit failure rolls back the change.

`payload_bytes` stores the byte length of the database’s text representation of each normalized receipt JSON. It excludes indexes, TOAST overhead, WAL, audit history, configuration journals, tombstones and backups. Triggers calculate the value rather than trusting the caller, and add/subtract it in the same transaction as a receipt write. Duplicate inserts and rolled-back transactions do not increase totals. This is not a measured capacity guarantee.

The migration backfills existing workspaces and receipts, then initializes a zero counter whenever a new workspace is inserted. It locks workspace creation across the backfill and trigger installation. A missing counter fails subsequent receipt writes or policy changes; it is never silently recreated with zero and historical usage lost. Investigate and reconcile such a failure under the migration role before resuming writes.

Compact signal tombstones retain the internal signal ID and source identity after future payload deletion. The insert guard preserves the existing duplicate result, including for older application binaries. No external raw event ID or provider body is retained in the tombstone. This part creates no tombstones or deletions through application APIs. Tombstone metadata has no automatic expiry here; expiring it would require an explicit ingest-age/deduplication contract.

## Upgrade and grants

Use the established migration role and backup procedure. Quiesce application writes while applying the migration and new grants, then resume the old or new binary. The backfill scans receipt tables and holds schema locks; measure lock duration and spare storage on a staging copy before production. The migration role must be able to bypass forced RLS. Transaction-local `row_security=off` fails when policies would filter the backfill; it does not bypass them.

In the application schema, grant the restricted runtime role SELECT, INSERT and UPDATE on `escalator_retention_policy` and `escalator_replay_usage`, and SELECT and INSERT on `escalator_signal_tombstone`. Keep the existing SELECT/INSERT receipt grants. Production receipt DELETE grants belong to the later guarded-pruner activation; UPDATE on normalized receipt tables remains denied. Do not grant ownership, BYPASSRLS or broad privileges on every table. Triggers run with the caller's privileges.

A receipt producer must lock one source before the accounting row and must not lock a second source afterward. Policy writes lock the accounting row and take no source lock. Workspace creation initializes its counter before the workspace becomes visible to other transactions. Preserve this order when adding future batch or pruning operations.

## Conformance procedure

Run the existing opt-in suites only against an already available disposable database:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

Standalone requires `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`. Dashboard requires `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL`. There is no DATABASE_URL fallback. The migration and application roles must be distinct; the application role cannot bypass RLS.

Cases cover populated upgrades, zero counters for new workspaces, all three receipt types, duplicate/rollback accounting, policy CAS and audit rollback, tenant isolation, negative-total rejection and tombstone duplicate suppression. Accounting fixtures alone receive receipt DELETE permission in their random test schema to check decrement arithmetic. Those direct fixture deletes do not test pruning eligibility or authorize production deletion. The separate memory policy cases cover permissions, ceilings and expired/poisoned transaction handles.
