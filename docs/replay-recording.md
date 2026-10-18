# Replay recording and database upgrade checks

The recording migrations add source/probe configuration journals, availability metadata for metric versions, and receipt metadata for signals and probes. Existing host repositories write through the same ports; database triggers also capture writes from the previous application binary during a rolling upgrade. The triggers run with the caller's privileges and bind data values; they do not use security-definer privileges.

New signal receipts retain the source configuration revision that was locked during ingestion. This is separate from the signal envelope's format version. New probe receipts retain the probe revision, database receipt time and scheduled time from a matching durable job. A missing or mismatched job leaves scheduled time unknown. Actual observation timestamps remain unchanged; scheduled time is not evidence that a request ran on time.

Current configurations found during migration are captured as known from migration time onward. Their original JSON, including its earlier update timestamp, is preserved. The capture must not be projected backward into historical coverage. Old probe receipts keep NULL availability, schedule and relational revision fields. Old signals keep NULL source revisions. Historical metric versions that are no longer current keep unknown availability; current versions receive a migration-time capture. Future changes append immutable version records.

This part records the inputs for T3.12. Retention deletion, coverage queries, maintenance scheduling and UI are subsequent parts. It does not claim complete historical replay after an upgrade.

## Upgrade prerequisites

Back up the database and use the deployment's existing migration procedure. The migration role must own the relevant objects and be authorized to bypass their forced row-level policies. The migration uses transaction-local `row_security=off` so incomplete policy-filtered backfills fail instead of silently omitting organizations. That setting does not bypass policies; PostgreSQL documents the distinction in its [row-security configuration reference](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-ROW-SECURITY). The runtime role must remain a distinct restricted role without ownership, superuser or BYPASSRLS privileges.

Before resuming application writes, grant the runtime role SELECT and INSERT on `escalator_source_version` and `escalator_probe_version`, in the deployment's application schema. Keep UPDATE and DELETE denied on these journals in this recording part. Existing metric-version and receipt privileges remain unchanged. Run migrations and grants before allowing the old or new binary to resume writes: recording triggers need the new journal privileges. Do not grant all privileges on all tables or disable row-level security.

The standalone migration runner wraps the checksum-verified migration sequence in a transaction. The additive Dashboard migration wraps its generated DDL and recording additions in its own transaction. On error, roll back and fix the migration-role/grant prerequisite before retrying. A backfill scans current source/probe configurations and current metric versions and adds indexes; assess lock duration and backup capacity on a staging copy before a production upgrade. No live lock or capacity measurement was performed here.

## Disposable PostgreSQL conformance

Use only an existing disposable database with distinct migration and restricted application roles:

- Standalone: `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`.
- Dashboard: `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL`.

No command falls back to the application's DATABASE_URL. Each fixture creates its own random schema and removes that schema afterward. The migration role needs BYPASSRLS or equivalent administrative authority for the backfill; the application role must not have it. Do not point these variables at a production database.

Run:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

On a staging database, additionally run the host's normal migration command twice and confirm its migration journal prevents a second backfill. Preserve the capture timestamps, journal counts and legacy NULL metadata across that rerun. Exercise old-binary writes after grants and verify the triggers capture them; then upgrade the application binary. These runtime checks are procedures only here. No server, database, container or provider was started.
