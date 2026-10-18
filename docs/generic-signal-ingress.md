# Generic machine signal ingress

Standalone exposes `POST /v1/ingest/:sourceId`. This is the documented machine
exception to application tRPC APIs. Requests use an expiring, source-bound
`Authorization: Bearer <token>` grant; a browser cookie provides no authority.
Only the installation's configured workspace can authenticate a grant.

Administrators create generic sources through authenticated `signals.create`,
edit them with `signals.update` and the displayed version, issue grants through
`signals.issueToken`, and revoke by ID through `signals.revokeToken`. Source reads
use `signals.list` and `signals.get`. All mutations use existing session/CSRF
protection, trusted host identity, package capabilities and transactional auditing.
Save the grant ID for revocation; its plaintext is returned only once. Expiring
grants default to 30 days and can be rotated with a replacement before revocation.

The source binds the service and environment. Request JSON supplies no workspace,
source, service, environment or received timestamp:

```json
{
  "version": 1,
  "eventId": "unique-provider-event-id",
  "fingerprint": "checkout-http-500",
  "observedAt": "2026-10-02T00:00:00.000Z",
  "status": "active",
  "severity": "critical",
  "title": "Checkout failed",
  "evidence": { "summary": "HTTP 500", "attributes": [] }
}
```

Send UTF-8 JSON with `Content-Type: application/json`. Raw parsing is mounted
before application routes, caps the body at 256 KiB while streaming and rejects
compressed content. Unfinished bodies are disconnected after ten seconds.
Decoded bodies from another parser are refused; there is no unbounded fallback.
The controller removes raw evidence from the request before subsequent reporting.

Acceptance returns 202 only after event, processing job and audit commit; a
repeat event ID returns 200 without replacing evidence or scheduling more work.
Malformed input returns 400, invalid/unadmitted grants 401, oversized payloads
413, unsupported content types/encodings 415, and unavailable persistence 503.
Retry a lost response or transient failure with the same event ID and payload.
Use a distinct event ID and `status: recovered` for a recovery notification.

This part activates durable intake, not incident grouping or paging from signals.
The `signal.process` handler follows in T3.4; intake alone is not a functioning
outage detector. Provider-specific signatures and Sources UI follow separately.
No live HTTP listener or PostgreSQL instance was started for verification. Unit
stream fixtures verify size rejection and parser ordering, not proxy behavior,
live request timeouts or process recovery. Validate those in a disposable
installation before rollout, using the PostgreSQL verification procedures.
