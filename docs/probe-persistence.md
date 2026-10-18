# Probe persistence contract

The shared `ProbeRepository` joins signal ingestion, durable work and audit on the host's existing PostgreSQL transaction. Its scoped primitives store versioned configuration, the next scheduled job, immutable observation receipts and the latest threshold state. The durable execution use case is included; SQL adapters and runtime activation follow in subsequent layers.

All lookups use the authenticated workspace. Dashboard maps it to the WorkOS organization ID. Configuration has one owning source of kind `probe`; source, service and environment identity cannot change. A source can own only one probe. Conditional version writes prevent concurrent editors from overwriting each other.

Mutations lock the source before the probe, followed by the work claim. Observation, state and schedule writes require the probe lock. Shared transaction guards validate timestamps, identity and versions, poison a transaction after a caught repository failure, and reject escaped handles after completion. State writes are checked against the stored observation and the same threshold evaluator used by the runner.

A scheduled job ID includes scope, probe ID, configuration version and due time. The next due time stays on that interval's cadence but skips slots missed during downtime; it never manufactures historical observations or replays a backlog of synthetic writes. Disabling clears both the job ID and due time. The scheduler use case enqueues/cancels work and saves that pointer in the same transaction.

## Durable execution

`ProbeExecutionJobs` checks the persisted job and configuration under a live lease, releases the transaction for HTTP, then checks the lease, version, source and service again before saving an observation. A configuration edit cancels the obsolete job. A committed observation is the run receipt: a crash before lease settlement cannot repeat the HTTP request or enqueue another successor. A crash before the observation commit can repeat the request with the same synthetic idempotency key; the target must honor it.

Observation, threshold state, emitted signal, successor and redacted audit commit together. Unknown telemetry keeps the schedule alive without manufacturing recovery. Disabled sources skip HTTP and produce unknown observations. Missed slots are recorded in audit metadata. Cancellation or lease loss prevents a stale runner from committing its result. Existing probes can be disabled while their secret is unavailable; new bindings and re-enabling require a usable secret. Only a committed run enqueues its successor, so `DurableWorkRunner` never settles an exhausted `probe.execute` job as failed: it re-arms the same job (its schedule pointer stays valid) after the maximum retry backoff with a fresh attempt budget. A persistent fault therefore retries indefinitely instead of silently stopping the probe.

## Conformance suite

`packages/features/test/conformance/probes.ts` is reusable by the standalone PostgreSQL and Dashboard Prisma fixtures. Its in-memory registration checks:

- Tenant isolation, including equal IDs in different workspaces.
- Concurrent version edits and exclusive source ownership.
- Atomic rollback of observation, threshold state, signal, schedule, work and audit.
- Immutable observation receipts and rejection of invented/replayed state.
- Canonical schedule identity and required probe locks.
- Caught-error rollback and closed transaction handles.

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/features test`. Execution tests also cover restart after receipt commit, configuration/lease races, disabled sources, threshold recovery, missed slots and rollback after HTTP. The in-memory adapter verifies shared semantics only; it does not prove PostgreSQL locking, constraints or row-level security. Adapter-specific registrations and migration procedures follow with those implementations. No test database is configured, and no database or server has been started for these checks.
