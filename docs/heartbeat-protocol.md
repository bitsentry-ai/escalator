# Heartbeat deadline protocol

The shared heartbeat use cases persist a last accepted ping, its observed time, an absolute deadline and a generation. Host database adapters and authenticated machine routes are delivered in subsequent stack layers; this package layer alone does not expose a heartbeat endpoint.

## State and authorization

A heartbeat owns a `heartbeat` signal source and immutable service/environment identity. Configuration versions and deadline generations fence edits and pings. Disabling invalidates pending deadlines and preserves an existing missed state; disabling is not recovery.

Machine grants have the separate `heartbeat:write` scope and an `ehb_` token prefix. Only a SHA-256 token hash is stored. Grants expire within 90 days and support revocation. Authentication first resolves trusted scope from the hash, then rechecks the grant, probe, source and service inside the scoped transaction. Signal-ingestion credentials cannot authorize heartbeat pings.

A ping carries `version: 1`, an opaque `eventId` and UTC `observedAt`. It cannot choose tenant, source, service or acceptance time. New observations must be no more than five minutes old or one minute ahead, and strictly newer than the last accepted observation. Database time determines acceptance and the next deadline. Keep receipt retention longer than the five-minute acceptance window so pruning cannot turn an old replay into a new ping.

A duplicate event returns its original acceptance/deadline without extending liveness. Revoked or expired grants cannot replay even a previously accepted event. Each new ping atomically records its receipt, advances state, cancels the obsolete deadline, schedules its successor and appends an audit event. A ping following a recorded miss emits an explicit recovery signal in the same transaction.

## Deadline races and restart

Source and heartbeat rows are locked before grants and work rows. A miss handler rereads its persisted claim and requires the current configuration version, generation and deadline job ID. A ping which wins the lock cancels an obsolete miss, including a previously claimed miss.

A miss occurs only strictly after its deadline. At the exact millisecond boundary the handler waits one millisecond; a later accepted ping is therefore strictly newer than the miss signal. This preserves the common signal engine's rule that active events win equal-timestamp ties without fabricating event timestamps.

A recorded miss clears its deadline pointer and emits one active signal atomically. A crash before lease settlement can replay the handler, but the cleared pointer prevents a second signal. Further silence never emits recovery. If the owning service is disabled, the handler waits instead of claiming an outage; re-enabling a still-enabled heartbeat with an expired deadline allows that miss to be recorded. An operator can edit the heartbeat to start a fresh deadline explicitly. An exhausted `heartbeat.deadline` job is never settled as failed: the durable runner re-arms the same job after the maximum retry backoff with a fresh attempt budget, so a persistent fault delays the miss instead of losing it.

## Adapter contract and verification

Both hosts must compose the heartbeat store with existing signal, durable-work and audit storage on one physical transaction. The shared guard enforces scope, immutable ownership, version checks, grant validity, receipt-backed ping transitions and closed/poisoned handles. Grant reads must lock their rows until commit; all reads and unique keys are tenant-scoped except the trusted globally unique hash lookup.

The shared conformance suite covers idempotent receipts, trusted scope, revocation, rollback, prohibited recovery writes and handle lifetime. In-memory deadline scenarios cover a claimed miss cancelled by a ping, restart before settlement and the exact timestamp boundary. Real PostgreSQL contention/RLS checks require the disposable test configuration that has not been supplied. No infrastructure or server listener is started by these tests.
