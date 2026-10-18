# Durable retention maintenance

This shared T3.12 implementation defines the schedule state, guarded transaction,
bootstrap/repair operation, job handler and PostgreSQL schedule adapters. Runtime
registration follows separately; no production timer or deletion handler is
registered here.

Each workspace has one schedule with a monotonically increasing revision, current
job ID, source ID, receipt cursor, due time and sweep timestamps. Jobs have a closed,
versioned payload and a deterministic workspace/revision identity. A control job
chooses the first source. A source job invokes the bounded pruning transaction,
then persists its successor job and cursor with the same commit. Empty and protected
batches advance even when no deletion audit is needed.

A batch can delete records while retaining its cursor: SQL preserves timestamp
fractions that JavaScript's millisecond comparison cannot distinguish. The next job
must revisit any earlier physical receipt that the capped deletion left behind.
Progress means either deleting records or advancing the cursor; it does not require
a non-null cursor after every batch.

## Failure and restart behavior

The handler reloads schedule state and the authoritative work claim under locks.
Caller-supplied payload, kind and attempt fields do not choose a source or cursor.
Expired or replaced leases do not advance the schedule. A crash after committing a
successor but before settling the old job is harmless: retrying that old job sees
an advanced schedule and completes without repeating deletion or its audit.

Bootstrap preserves an existing pending or running job. If its current job is
terminal or missing, bootstrap preserves the source/cursor and schedules a new
revision with a one-hour repair delay, recording the repair atomically. A malformed
kind or payload fails closed instead of silently replacing unexplained work.
Normal sweeps repeat hourly with one-second spacing between batches. These are
bounded deployment settings, separate from user-managed retention days and bytes.
Hosts should invoke bootstrap periodically as well as at startup so exhausted
retries cannot leave maintenance stopped indefinitely.

Any failure writing the audit, successor or schedule rolls back deletion and byte
accounting. Caught port failures poison the enclosing transaction, and transaction
handles cannot escape their lifetime. Completing a sweep means traversing its
sources; it does not promise usage fell below the target when protected data alone
exceeds that target.

## Host adapter requirements

- Serialize the singleton even before its first row exists. For a source job,
  lock that source before the singleton, then its work claim, related receipt jobs
  and workspace accounting. Bootstrap takes only singleton/work locks.
- Keep the initial unlocked schedule read as a hint. Revalidate its revision and
  source under physical locks before invoking the pruning port.
- Implement `nextSource` as a scoped, indexed ID seek without a row lock. Never
  acquire another source lock after accounting.
- Lock the current job when examining it for repair; use the same physical
  transaction for successor enqueue, schedule compare-and-swap and repair audit.
- Compose the shared transaction guards with the existing PostgreSQL pruning store.
  Preserve organization mapping and forced row-level security in the Dashboard.
- Register a bounded maintenance lane with paging capacity reserved. Add bounded
  cleanup for obsolete, terminal maintenance work using exact validated identities;
  never delete current/live work or arbitrary job prefixes.

The shared memory scenarios exercise the real pruning use case and durable claim
store. They are not PostgreSQL lock, index or contention evidence. Run them with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

Database runtime verification, production activation and authenticated
retention/coverage management remain follow-up work before Phase 3 completion.

## PostgreSQL schedule adapters

Both hosts persist the shared maintenance state in a workspace-scoped singleton.
The Dashboard column is `organization_id`, using the WorkOS organization ID.
An advisory transaction lock serializes first initialization; subsequent writes
also lock the row and compare its revision. Foreign keys bind the current work to the same workspace and protect it from
deletion. Source IDs are traversal hints, selected by a scoped query and validated
under a source lock before pruning. They deliberately have no foreign key: moving
the cursor must not implicitly lock the next source after byte accounting. A
foreign or missing source hint fails before the pruning transaction is exposed.
A nullable JSON cursor preserves the receipt timestamp's PostgreSQL precision.

Each batch locks its source before the singleton and work rows, then composes the
existing pruning transaction. Payload deletion, byte accounting, audit, successor
intent and cursor movement commit together. Source traversal uses an indexed ID
seek without taking a second source lock. Statement and lock timeouts remain five
and one seconds. These adapters do not yet start a production scheduler; runtime
admission and management screens follow.

### Disposable database verification

**Not runtime-verified:** no test database was available. Follow the role and
explicit-variable setup in [the pruning procedure](postgres-retention-pruning.md),
then run from the root checkout:

```sh
pnpm run escalator:build:packages
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

Verify that all six `retention maintenance` cases execute in each host, rather
than skip. They exercise concurrent initialization, tenant isolation and foreign
keys; 100/5-row continuation and retry after commit before lease settlement;
audit-failure rollback; and expired-owner fencing with delayed repair after an
exhausted job. Two further cases cover obsolete-job cleanup, cross-tenant and
malformed-work protection, retry idempotency and cleanup-audit rollback. Existing
pruning cases use the same fixture and still run.
The fixture grants schedule SELECT/INSERT/UPDATE only to its restricted test role.

Before operational activation, also measure query plans and lock contention with
production-shaped histories in an authorized environment. Passing shared memory
tests or compiling these opt-in cases does not establish PostgreSQL performance,
physical locking behavior, or a completed database migration rehearsal.

## Obsolete maintenance work

Each valid current maintenance claim can retire at most 100 old maintenance jobs
before it takes receipt/accounting locks. The same transaction commits deletion,
a `retention.jobs.pruned` audit, any receipt pruning, and the successor schedule.
The guard rejects repeated cleanup or cleanup after accounting has begun. A retry
of an already-committed claim does not repeat cleanup or its audit.

Eligibility is shared across hosts: exact `retention.sweep` kind, a closed version-1
payload, deterministic workspace/revision identity older than the current schedule,
terminal state, no lease, and completion at least seven days before database time.
The current job, pending/running work, malformed records and unrelated kinds are
never deleted. Seven days is an internal work-history grace period; it does not
change the user's payload-retention policy or remove audit records.

Both PostgreSQL adapters select at most 100 candidates with row locks and
`SKIP LOCKED`, validate their identities through the shared helper, and reconcile
the deletion count. An additive `(scope, kind, completed_at, id)` index supports
that bounded query. Protected malformed rows remain in place and may delay later
cleanup if they fill the candidate window; unexplained work requires inspection,
not relaxed validation. The existing current-job foreign key also prevents deleting
a schedule's active reference.

Run the shared and both-host commands above. Database cases and physical query-plan
and contention measurements remain **not runtime-verified** until an authorized
disposable PostgreSQL environment is available. These changes do not start a timer.
