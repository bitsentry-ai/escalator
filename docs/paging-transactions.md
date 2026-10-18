# Paging transactions and acknowledgement

Paging decisions hold the page row lock before reading its state or writing effects.
Any work-row lock comes after the page lock. A scheduler lease object is only a
claim reference: `work.lockClaim` checks the persisted scope, token, running state
and live database expiry, then returns the stored kind, payload and attempt number.
PostgreSQL adapters acquire the row lock before evaluating expiry so a lock wait
cannot authorize an expired claim. No network I/O belongs inside this transaction.

`steps.forPage`, `deliveries.forPage` and `attempts.forDelivery` filter within the
workspace in storage and paginate by ID. Dispatch and cancellation must use these
queries rather than scanning unrelated pages. Parent fields use the existing
composite indexes; this change needs no schema or migration.

## Recipient token acknowledgement

Raw tokens are canonical base64url encodings of 32 random bytes. Only their SHA-256
digests enter the grant repository. The HTTP layer must keep raw tokens out of
request logs, query strings, audit data and durable work payloads. The upcoming
mobile route accepts them from the fragment into a POST body. GET preview is
read-only and never acknowledges a page.

The acknowledgement use case looks up a scoped grant, locks its page, and checks
expiry again using live database time. The first acknowledgement sets the owner;
later valid tokens report that same owner. A resolved page stays resolved. Disabled
responders cannot acquire ownership. Ownership, pending escalation/delivery
cancellation, provider-cancellation job intents and the audit record share one
transaction. An audit failure therefore rolls all of them back.

Pending receipt polls are cancelled too. Pushover cancellation is a separate durable
job per delivery, not a network call under the page lock. Dispatch must use the same
stable work-ID derivation and register the `paging.cancel` handler before activating
paging. That handler and the remaining dispatch pipeline are supplied by subsequent
T2.5 parts. The cancellation job resolves the contact and creates an authorized
provider outbox operation; it contains no secret ID or raw acknowledgement token.

An already-running provider request may still finish after acknowledgement.
Its attempt result must be recorded independently of the cancelled outbox lease,
with the late-completion flag, followed by another durable cancellation intent if
needed. Cancellation before a late provider acceptance cannot prove that retries
stopped. The dispatcher must account for this race explicitly.
