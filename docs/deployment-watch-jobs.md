# Deployment watch jobs

The shared watch runtime is not registered in either host yet. Both hosts must first compose their evidence readers and overlap queries on the same transaction, provide cadence handlers, compose the shared detector correlation adapter, and reserve bounded worker capacity. Registering only the finish decorator would create jobs without their handlers.

## Transaction boundary

An accepted first finish initializes its watch and retention pins, then enqueues a watch job and a separate cadence job. All three effects commit with the lifecycle revision and receipt. Replayed/stale lifecycle writes do not enqueue new work. A timeout alone does not start a watch; a late finish does.

The first evidence poll is due one minute after the server-recorded finish. An early job waits rather than treating a zero-length observation window as evidence. The cadence job is immediate and separate: its future adapter must acquire capacity before target/source locks. Watch evaluation never acquires capacity or performs provider I/O.

The watch handler locks the target, reads captured historical evidence under ordered source locks, locks its detection group and page, then fences the persisted work claim. Expired or superseded claims cannot persist a verdict or page. Authoritative persisted kind, identity and payload must match the watch; caller-supplied lease metadata is not trusted.

The evaluated record, incident/page, paging jobs and transition audit share the same transaction. A failed watch uses one deterministic incident identity and retains its incident link and first failing evidence through retries and later healthy samples. Existing linked incidents are validated, not reopened. Final records remain immutable. The shared correlation adapter uses the failing probe or metric monitor's existing detection fingerprint. It links an open group incident, or reserves the group for the watch's new incident. A subsequently processed detector signal finds that incident; no synthetic signal or altered observation watermark is needed. Existing recovery and acknowledgement state is preserved when linking. Host composition of this adapter remains pending.

## Observation limits

The evidence port must use the captured baseline and source inventory, historical configuration versions and the fixed receipt cutoff at watch end plus two minutes. Delayed workers must not add later evidence. Overlapping deployment IDs are bounded and incomplete inventory must remain explicit. A verdict indicates observed health, not that a deployment caused a failure.

Successful polls wait at most one minute until the fixed final deadline. Durable work adapters reset retry attempts on successful waits. Missing baseline or incomplete telemetry finalizes as `INSUFFICIENT_DATA`; it cannot produce a healthy result. Provider delivery remains in the existing outbox and the watch never rolls back a deployment.
