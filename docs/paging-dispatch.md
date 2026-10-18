# Durable paging dispatch

`PageCreation` writes the operational incident, immutable page policy, every
escalation deadline and the opening audit in one transaction. Retrying the same
incident ID with the same content returns the original page; reusing that ID with
different content fails. A racing unique insert reads the winner only after its
own failed transaction has rolled back. Policy edits never rewrite existing pages.

`PageAdvancement` locks the page, validates the persisted work claim, then reads
routing through the same scoped transaction. The host implements database reads;
the package owns schedule resolution, contact ordering and escalation decisions.
A missing schedule, disabled responder or lack of enabled contacts produces an
explicit uncovered step. On-call duty remains independent of working hours.

Responders are selected at the step's original deadline. The first resolution
freezes recipients, contact IDs and channel choices. Contact priority sorts low to
high, with contact ID as a deterministic tie-breaker; one route is selected for
each recipient. Only opaque secret references and their approved binding IDs enter
the outbox. Provider addresses and credentials remain in the secret store.

After downtime, only the current overdue escalation level receives new delivery
intents; obsolete unrecorded steps become skipped. Advancing also cancels older
delivery/polling work and queues Pushover cancellation. Concurrent or reclaimed
processing cannot replace frozen recipients or create another logical delivery.
A clock rewind after claim retains the unprocessed deadline by requesting retry.
Fallback exhaustion stays visible and never resolves the incident.

This part does not register production handlers. The next T2.5 parts supply
provider dispatch, attempt/grant persistence, receipt acknowledgement and
cancellation execution. Routing persistence and runtime adapters must use the same
physical transaction as paging; a second pool connection is not an implementation
of this port. Late provider acceptance after cancellation still requires a fresh
attempt-specific cancellation intent in the provider dispatcher.
