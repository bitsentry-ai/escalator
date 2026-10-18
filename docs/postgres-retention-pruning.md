# PostgreSQL replay pruning

Both hosts now implement the guarded, source-scoped pruning repository. This is
T3.12 adapter work; the production maintenance scheduler, authorized management
API and coverage screen follow separately. Nothing invokes deletion automatically.

A transaction locks the source, related work rows in ID order, then the workspace
byte counter. Each candidate stream is limited to 1,001 rows; the combined snapshot
returns at most 1,000 candidates and a continuation marker. Deletion is capped at
100 receipts. Statement and lock timeouts are five and one seconds respectively.
Three additive indexes support probe/metric seeks and alert-reference checks.

A receipt requires a matching completed job with a valid payload and no lease.
Signals also require their processed marker. Missing, failed, cancelled, pending,
running or malformed work protects the receipt. All alert last-signal references,
current probe results/schedule jobs and current metric schedule references remain
protected. Enabled metric monitors additionally protect their current version's
live evaluation window, including the late-evaluation allowance.

Deletion writes signal tombstones before removing their processed markers, terminal
jobs and normalized payloads. Counter triggers, row/byte reconciliation and the
maintenance audit share the transaction. An audit failure rolls everything back.
Tombstones preserve duplicate detection after payload deletion. Historical
configuration versions, audit records, outbox rows and tombstones are not pruned.

## Opt-in conformance procedure

Use an existing disposable PostgreSQL database with distinct migration-owner and
restricted application roles, as described in the host database conformance guide.
The application role must not be superuser, BYPASSRLS, or a member of the owner role.
Provide both variables for the host being checked through your normal secret
injection mechanism; do not commit their values:

- Standalone: `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`.
- Dashboard: `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL`.

From the repository root, after the documented workspace setup:

```sh
pnpm run escalator:build:packages
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

Each fixture creates and drops only its random test schema. Pruning fixtures grant
DELETE on the three receipt tables, processed markers and jobs; ordinary ingestion
fixtures retain their narrower grants. The five shared cases cover protected work
and alert references, tombstone dedupe and tenant isolation, audit-failure rollback,
100-row continuation, concurrent sweeps, and probe/current metric protection.
Confirm all five run in each host instead of being skipped. Physical query plans,
large-history latency and concurrent ingestion contention still need measurement
in an authorized environment; the bounded query text is not performance evidence.

Before enabling maintenance, compose these repositories with a durable fenced job
and atomic continuation. Add deploy-baseline/backtest pin protection before those
later features activate. Keep the paging pool's capacity reserved when admitting
maintenance and coverage queries. Configuration-journal compaction requires its
own predecessor/reference rules; it is not implemented by this adapter.
