# Signal processing and recovery

The shared handlers consume persisted `signal.process` and `signal.recover` jobs.
They are not registered in either host until its detection adapter joins signal,
configuration, page and work primitives on one physical transaction.

Processing locks the source, group (including absent groups), existing page and
work claim in that order. Lease hints select locks only; the persisted claim must
match the event and deterministic work ID. An immutable processing receipt,
alert watermark, page, escalation deadlines and audit commit together. A worker
crash before lease settlement safely replays that receipt.

Automatic paging requires an enabled service/environment binding to an enabled
policy. Missing configuration throws without consuming the event; the runner's
bounded retries eventually surface failed work. Operator redrive and configuration
screens are subsequent integration work, not silent fallback to another policy.

Recovered observations schedule a revision-bound hold job only when all alerts
in the incident have recovered. Relapse cancels that job. Recovery rechecks every
contributor under the same group/page locks; silence never clears an incident.
Repeated recovery observations preserve the original hold start. A manual
resolution suppresses observations at or before its resolution time. A later
active observation can open a new incident after normal watermark checks.

`conformance/detection.ts` supplies host-reusable rollback, missing-group
serialization, scope, transaction-poisoning and immutable-receipt cases. The
memory adapter runs them now; each PostgreSQL adapter must register them using
the existing opt-in disposable-database harness. A memory pass does not verify
PostgreSQL locks, constraints or isolation. No database is configured here.
