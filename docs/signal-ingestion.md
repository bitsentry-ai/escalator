# Signal ingestion contract

This layer supplies the shared envelope, persistence ports and generic-token
ingestion use case. Host storage, streaming HTTP routes and administrative
source/token APIs follow in the next stack layers. It does not activate an
ingress endpoint or register a signal-processing handler by itself.

Machine callers provide a stable event ID, fingerprint, observed time, explicit
active/recovered state, severity, title and bounded normalized evidence. The
stored source supplies workspace, service and environment; the database supplies
received time. The input schema rejects caller-supplied routing or tenant fields.

The generic credential is `esi_` followed by canonical base64url encoding of 32
random bytes. Only its SHA-256 hash is persisted. Grants are bound to one source
and `signal:write`; the initial lookup supplies trusted scope, then acceptance
rechecks source state and the grant under the source lock. Expiry uses live
database time after acquiring locks, not the transaction's earlier start time.
Token revocation and source changes must take the same source-first lock order.
Generic intake rejects sources configured for provider-specific authentication.

The shared transaction commits the immutable event, a `signal.process` job and
audit together. Event uniqueness is workspace/source/provider-event-ID scoped.
Retries are a no-op and preserve the first evidence even if a retry changes its
body. Processing must resolve recovery ordering independently; receiving no
events is never interpreted as recovery.

Both host HTTP adapters must enforce the 256 KiB limit while reading, before
buffering and JSON parsing. The shared byte parser rejects oversized buffers and
invalid UTF-8. Host routes must map errors to bounded responses, avoid body and
credential logging, and require the path source to match the stored grant.

Run shared unit/conformance fixtures with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

The current conformance fixture runs in memory. Both PostgreSQL adapters will
register the same scenarios; database execution remains unverified without the
explicit disposable test database configuration described in the
[installation guide](install/README.md).
