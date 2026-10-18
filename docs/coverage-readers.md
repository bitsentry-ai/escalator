# Replay coverage metadata readers

Both PostgreSQL hosts read stream identity, immutable configuration metadata and receipt metadata in one SQL statement snapshot. The reader returns only timing, revision, cadence and evidence quality. It does not return HTTP request bodies, credentials, metrics query expressions or potentially large metric input-ID lists to the application. PostgreSQL may still read/decompress the underlying JSON to project quality and cadence fields; statement timeouts and staging capacity checks remain necessary.

Requests use a half-open UTC window of at most 31 days. The requested availability cutoff must be no later than the database snapshot time. A read accepts at most 10,000 configuration revisions and 100,000 receipts; the SQL fetches one extra row to detect overflow. Any overflow marks the entire report `query_truncated`. Five-second statement and one-second lock timeouts bound database work; these are deployment safeguards, not measured capacity guarantees.

Periodic coverage uses recorded configuration intervals. A configuration captured during upgrade starts at the capture time, even if its payload has an older update timestamp. Legacy versions without availability do not establish historical coverage. Non-monotone configuration effective times fail closed as unknown history; they are not mislabeled as a query-limit truncation. The probe cadence retains its original anchor; metric cadence follows the existing UTC epoch grid.

A failed HTTP assertion or network timeout can be useful evidence that a probe ran; an unknown outcome cannot. A probe that actually ran outside its scheduled cadence bucket is unusable for that earlier bucket. Legacy receipts without a known schedule or relational revision are counted as unassigned and cannot fill slots. Metric coverage uses complete count-sample quality, independently of whether the sustained-floor verdict paged anyone.

An event-driven source promises no cadence. Its receipt counts never prove uninterrupted monitoring or convert silence into healthy observations. Coverage is retained-evidence availability; it is not an incident verdict or the Phase 6 replay engine. Original receipt times still need filtering at every simulated decision in that engine.

## Verification procedure

The shared unit cases exercise interior gaps, capture boundaries, unassigned history, delayed probes, mismatched scope/identity, duplicate receipts, future cutoffs, truncated results and clock regression. Both host PostgreSQL suites include populated tenant isolation, probe schedule/receipt projection, metric metadata projection and event-source semantics.

With the existing disposable database variables configured, run:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

The variables are `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` for standalone, or `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` for Dashboard. No application's DATABASE_URL is used as a fallback. Follow the migration-role and restricted-runtime grant prerequisites in [replay recording](replay-recording.md).

No disposable database exists in this environment, so the SQL and PostgreSQL cases are not runtime-verified. Before activation, additionally run concurrent configuration changes and pruning against repeated coverage reads and confirm each result describes one statement snapshot; exercise the overflow and statement-timeout paths on a populated staging database. No infrastructure is started by this procedure here.

This part adds readers. Retention pruning, durable scheduling, authenticated API registration and coverage screens are subsequent work.
