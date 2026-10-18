# Standalone signal persistence verification

The standalone adapter stores source configuration, hash-only ingestion grants,
and immutable signal events in PostgreSQL. Signal acceptance commits its event,
`signal.process` job, and audit entry in the same transaction. No HTTP ingress is
activated by this storage change; route wiring follows in a later part of T3.1.

## Isolation and concurrency

Migration `0006_signals.sql` adds three tables with forced row-level security.
Every normal query also includes the authenticated workspace. Source rows are
locked before grant or event rows, using the same ordering as revocation and
source edits. Transactions use a five-second statement timeout and a one-second
lock timeout; a lock timeout rolls back acceptance, so the sender can retry the
same event ID. The natural key is `(workspace_id, source_id, event_id)`.

Before the workspace is known, authentication uses a separate short transaction
that sets only the exact token digest for a SELECT policy. That policy exposes
only the matching grant row, never another source, event, or grant. The adapter
projects workspace/source/grant IDs and resets the setting on commit or rollback.
It does not use a privileged connection or disable row-level security. The
subsequent acceptance transaction rechecks the grant after locking its source.
The lookup is not proof of authorization on its own.

Application roles need SELECT/INSERT/UPDATE on `escalator_signal_source` and
`escalator_signal_token`, and SELECT/INSERT on `escalator_signal_event`. Continue
using the restricted application role and separate migration role described in
[PostgreSQL verification](../../../docs/architecture/escalator-postgres-verification.md).
There is no reason to give the application role ownership, BYPASSRLS, or DELETE
permission for signal ingestion.

## Opt-in procedure

Use an existing disposable database, never the application's database. Set both
`ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` locally;
keep credentials out of source, shell transcripts, and PR descriptions. The
fixture requires different roles on the same database and creates and removes a
random schema. It applies migrations twice to check the migration journal.

Run from the repository root:

```sh
pnpm run escalator:build:packages
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
```

The signal suite must execute (not skip) shared conformance scenarios, populated
RLS isolation checks, exact-hash authentication lookup, concurrent duplicate
acceptance, and post-revocation rejection. Confirm only one processing job and
one audit survive duplicate requests. The RLS test also verifies that the lookup
setting cannot authorize writes and does not survive transaction completion.

Without both explicit test variables these cases register as skipped. The tests
and migrations have **not been runtime-verified against PostgreSQL** in this
implementation environment. Builds and in-memory conformance cannot establish
SQL locking, isolation, migration, or query-plan behavior.
