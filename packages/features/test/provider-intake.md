# Provider intake verification

The shared acceptance use case authenticates a persisted source and receiver,
normalizes the original bytes, then atomically writes signals, processing jobs
and audit records. Host routes and secret adapters must bind these exports before
provider intake is activated. Generic intake remains separate.

## Authentication modes

- Sentry: body HMAC with an opaque secret binding. The public receiver ID routes
  the request but does not authenticate it. Unsigned timestamp headers are not
  trusted. Issue notifications are active-only and require manual recovery.
- GlitchTip: scoped bearer grant, or HTTP Basic with the fixed `escalator` user
  and that same grant as password. Issue URLs must match the configured tracker
  origin. Native notifications lack a stable delivery identity and event time;
  each accepted request receives a receipt ID and database observation time.
- Grafana: explicitly configured bearer or timestamped HMAC mode. A request
  cannot switch between modes. HMAC timestamps must be within five minutes of
  database time, including the final check after secret retrieval.

Never use a public receiver ID as a bearer token. Receiver IDs and bearer grants
expire and can be revoked through the same persisted grant model. Source edits
increment the version, invalidating any acceptance prepared before the edit.

GlitchTip retries produce separate observations with a stable issue fingerprint;
incident grouping must suppress additional pages for an already-active alert.
Unlike Sentry/Grafana event identities, its receipts cannot identify a provider
retry exactly. Do not permanently deduplicate the entire native payload, since
that would suppress identical notifications from later outages.

## Automated checks

From the repository root:

```sh
pnpm run escalator:build
pnpm run escalator:typecheck
pnpm run escalator:lint
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

The in-memory tests cover authorization scope, mode changes, MAC failures,
revocation/expiry during secret retrieval, source version changes, secret metadata
revocation, transaction rollback, duplicate events, native receipt semantics and
safe HTTP failures. These tests do not start a server or database.

## Host integration requirements

Secret access for inbound verification is a distinct permission from durable-job
secret access. The host validates the receiver, source version and secret binding
before exposing plaintext to the synchronous verification callback. Dashboard
broker access must repeat authorization after network I/O. Owned plaintext
buffers must be cleared; neither callbacks nor diagnostics may retain them.

The acceptance transaction checks enabled secret metadata under a lock that lasts
until commit. Standalone uses `FOR SHARE`; Dashboard broker integration must
supply the equivalent scoped metadata check in its surrounding transaction. The
Dashboard default refuses secret access until that integration is provided.

PostgreSQL locking, provider delivery and proxy behavior are not runtime-verified
here. With the opt-in disposable database configuration described in the host
conformance guides, verify that disabling a secret waits for an in-flight final
acceptance transaction and that a subsequent request is rejected. Repeat for
source edits and receiver revocation, including two concurrent connections.
Retain deduplication identities for at least the receiver validity window when
adding evidence retention; otherwise a valid old signed request could be accepted
after its event identity was pruned.
