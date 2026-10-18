# Paging channel adapters

Both hosts consume the compiled `/channels` export. Credentials are strict JSON
resolved through `SecretStore.withSecret` using the persisted outbox claim. The
adapter never returns credentials, provider error bodies, or acknowledgement
links. Those links exist only while dispatching; persist their digest through the
paging repository, never the raw link in jobs, attempts, audit, or logs.

## Pushover

Configure a separate individual user key per contact with `{ "token": "…",
"user": "…" }` and an optional device name. Emergency messages use explicit retry
and expiry settings. Dispatch must bound expiry to the relevant paging window.
A successful send returns an opaque receipt. Missing or malformed receipts and
transport failures are `unknown`, because the provider may have accepted the
request. An explicit provider rejection is distinct from an ambiguous result.

Receipt polling authenticates with the application token and accepts acknowledgement
only when its user key matches the configured recipient. Group acknowledgements
cannot establish individual ownership through this adapter. Poll no faster than
once every five seconds. The dispatcher must atomically apply the first verified
acknowledgement and schedule cancellation of outstanding deliveries. Cancellation
uses a workspace-separated delivery tag, so it also covers a request accepted by
Pushover whose receipt response was lost. Repeated cancellation is safe; failures
remain unknown and require durable retry. This part supplies the provider operations;
T2.5 connects their lifecycle to persisted dispatch and acknowledgement.

Provider contracts: [message API](https://pushover.net/api) and
[receipt API](https://pushover.net/api/receipts). Tests use synthetic credentials and
recorded response-shaped fixtures derived from those contracts, not live captures.
No notification was sent and no live provider callback was exercised.

## Generic webhook

Credentials are `{ "url": "https://…", "bearerToken": "…" }`; the bearer token is
optional. The JSON envelope contains version 1, delivery ID, title, message, and
the transient acknowledgement URL. `Idempotency-Key` is the delivery ID and remains
stable across attempts. Receivers must deduplicate it. HTTP 2xx confirms acceptance;
408, redirects, 5xx and transport failures remain unknown. HTTP 429 is a retryable
rejection. Other 4xx responses are permanent rejections.

## Outbound network policy

`PublicHttpsChannelTransport` accepts HTTPS on port 443 only. It resolves once,
rejects every answer if any address is private or special-use, and pins the selected
address while retaining the original TLS hostname and certificate verification.
IPv6 is limited to global unicast with special and transition ranges excluded.
The policy intentionally rejects some publicly reachable special-use exceptions.
No proxy, redirect, or reusable connection can substitute another destination.
Private webhook endpoints are unsupported by this initial policy.

Requests are bounded to 16 KiB, response bodies to 64 KiB, response headers to
16 KiB, and the total operation including DNS to ten seconds. Cancellation aborts
an active request. Only the three adapter-owned headers are accepted. Errors are
sanitized before they leave the transport. DNS and socket fixtures exercise these
rules without starting a server or using network credentials.

Implementation references: [Node HTTPS](https://nodejs.org/api/https.html),
[IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/),
and [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).
Real DNS, TLS, provider receipt expiry, and retry cancellation remain not runtime-verified.
Dashboard secret activation still depends on integration of the separate broker
stack (D3); this work does not merge or duplicate it.
