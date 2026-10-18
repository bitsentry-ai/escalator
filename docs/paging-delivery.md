# Durable page delivery

`PageDelivery` consumes the persisted `paging.send` outbox intent. It locks the
page before the work row, verifies the live claim and reads approved secret IDs
from the stored payload. Acknowledged, resolved or superseded ladder steps cannot
start another send. The provider receives the claim-bound secret-use context;
credentials are resolved by the host secret adapter only during the request.

Before network I/O, one transaction commits an in-flight attempt and an
acknowledgement grant. The credential is 32 random bytes, encoded as base64url;
only its SHA-256 digest is stored. The transient link uses the URL fragment so the
credential is not part of the initial HTTP request. The acknowledgement screen
and POST endpoint follow in the route/UI part. The configured public base URL is
an operator setting; use HTTPS for deployment.

Accepted attempts retain an opaque receipt and suppress resending if a worker
crashes before settling the outbox. A failed response retains only an allowlisted
reason and whether retry is allowed. Ambiguous requests remain unknown. Retries
get separate attempts and grants, use exponential jitter between a 5-second base
and a 60-second ceiling, and remain bounded by the runner's attempt budget.
They never move the independently persisted escalation deadlines. Webhook
idempotency keys remain stable across attempts; external delivery is at least once.

Acknowledgement can commit while provider I/O is pending. Its cancellation
revokes the outbox claim, but the fenced attempt can still record the late result.
A late Pushover completion queues a distinct cancellation intent, covering the
race where the first cancellation reached the provider before the send did.
If recovery already marked the old attempt unknown, that result remains immutable;
a separate audit event retains safe late evidence without changing its retry.

Each accepted Pushover response creates its own durable receipt polling intent,
including late evidence after recovery, with an absolute expiry bound.
Acknowledgement cancels polling across every attempt of the delivery. A new job-only `wait` result allows a successful pending poll to
reschedule without consuming the consecutive failure budget. Both PostgreSQL
adapters reset that budget under the same token/expiry fence. Outbox work cannot
use `wait`. Receipt reconciliation and provider-cancellation handlers, production
routing persistence and host registration follow in subsequent parts; this part
does not activate sends in either host.

## Verification and runtime gaps

The feature suite exercises committed grants before I/O, duplicate claims,
recovery before settlement, ambiguous retries, permanent and retryable rejection,
late acceptance after acknowledgement, stale deadlines and safe receipt storage.
Provider calls use in-memory fixtures and do not send real notifications.

The durable-work conformance suite includes pending-wait scheduling, budget reset,
stale fencing and rejection of waits on the outbox. The same suite is registered
against both PostgreSQL adapters. Follow [paging-persistence.md](paging-persistence.md)
for a disposable database; no database was available during implementation, and
these checks remain not runtime-verified. Dashboard secret activation also depends
on integration of the separate `secret-store/*` broker stack (D3).
