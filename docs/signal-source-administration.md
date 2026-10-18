# Signal source administration

The shared source-management use cases accept an actor constructed by each host's
identity adapter. They never accept a workspace from request input. Existing
`service:read` and `service:manage` capabilities govern reads and administrative
changes, respectively; viewers and responders cannot issue or revoke grants.

Generic sources bind to one service and environment at creation. Updates require
the displayed version and preserve the source kind, service and environment.
Disabling a source causes subsequent intake authorization to fail. Source writes,
grant changes and their audit entries share one transaction, so an audit failure
cannot leave an unaudited change behind.

Ingestion grants contain 256 random bits. The raw `esi_` value is returned once,
after commit; only its SHA-256 digest is stored. Audit records contain the grant
ID, not its plaintext or digest. Grants expire after 30 days by default and can
be configured for 60 seconds through 90 days. These are operational defaults,
not a new product capability. Rotation issues a replacement before revoking the
old grant. Revocation is idempotent and preserves the first revocation timestamp.
Every authorized revocation request receives its own audit entry.

The shared HTTP facade returns 202 for accepted events, 200 for duplicates,
401 for invalid or out-of-scope grants, and generic 503 responses for persistence
failures. Hosts must supply an explicit workspace-admission callback. JSON media
type, UTF-8 validity and bounded parsing are checked without exposing credentials
or database errors. Hosts must additionally limit bytes while streaming, before
constructing the request buffer.

These use cases are not yet exposed by host routes in this part. The following
host-wiring parts bind them to authenticated tRPC procedures and the bounded
machine-ingress endpoint. Provider-specific source creation is introduced with
its own adapter; generic ingestion cannot mint grants for a probe or a provider
signature endpoint.
