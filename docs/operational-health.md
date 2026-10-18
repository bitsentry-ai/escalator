# Operational health and external watchdog contract

Both hosts register the shared health evaluator against their scoped database reader and actual scheduler. Authenticated readiness and optional outbound watchdog delivery are configured through trusted deployment settings; see [operational-health-setup.md](operational-health-setup.md).

Readiness requires a fresh, scoped database snapshot and completed claim/settlement operations in every registered scheduler lane. A timer tick, an empty handler group, an unstarted scheduler or a stopped scheduler is not evidence of progress. An idle claim is useful evidence only alongside the database snapshot showing no overdue work. Provider acceptance and mailbox delivery remain separate states in incident delivery history; readiness does not assert either.

Default limits are five seconds for the health query, sixty seconds since scheduler progress, sixty seconds for overdue paging/outbox work and five minutes for other operational jobs. Exceeding a limit fails readiness. Database failures, malformed snapshots and missing progress fail closed. Concurrent checks share one pending read. A timed-out read is aborted, and another read cannot accumulate behind it until it settles. Host readers must also bound pool acquisition and SQL execution.

Database readers must use a consistent database timestamp, scope every query to the local workspace or WorkOS organization, include pending and running due work, and fail if the foundational workspace is absent. Watchdog jobs under `health.watchdog.` are excluded from operational queue lag: monitoring delivery must not prevent its own recovery. The active watchdog scheduler lane still needs real progress. Host health responses must not include job payloads, secrets, addresses or SQL errors.

## Watchdog behavior

An optional trusted deployment setting selects an opaque credential ID and an interval of 30–300 seconds (default 60). The encrypted credential uses the existing webhook shape: an HTTPS `url` and optional `bearerToken`. The shared public HTTPS transport pins validated public DNS, refuses redirects and bounds time and response size. Dashboard credentials continue to depend on the separate broker integration.

A small coordinator only enqueues a PostgreSQL intent for the current database-time interval. Its timer is never health evidence. Repeated ticks and replicas deduplicate that intent. Each configuration gets a scoped, deterministic job kind, so rolling replicas with different destinations or intervals cannot consume one another's work. Only the matching handler claims the job. No URL or token enters its payload.

The durable handler validates the persisted claim, configuration and current interval, obtains credentials through that claim, evaluates fresh readiness after broker access, rechecks the database fence, then sends a GET heartbeat. Failed readiness, expired claims and obsolete intervals suppress network I/O. Provider or post-send broker uncertainty is reported as unknown, without exposing error details. Diagnostic observer failure cannot stop durable processing. An in-flight heartbeat cannot be recalled if readiness changes after transmission.

A new interval seeds a new intent even if a preceding attempt exhausted retries. Active handlers discard expired intervals. Retention must also retire expired intents left behind by removed configurations; that cleanup is part of T3.12. Operators must allow startup grace while scheduler lanes establish their first actual progress and complete configuration changes across all replicas.

## Verification scope

Unit scenarios cover queue-age boundaries, stopped/stalled schedulers, timer-only false positives, database timeouts, stranded-query backpressure, scoped intent deduplication, rolling configuration isolation, readiness degradation during secret access, expired claims and post-send uncertainty. The tests use in-memory repositories and transports. PostgreSQL behavior, real watchdog delivery and host endpoint operation still require an authorized runtime environment.
