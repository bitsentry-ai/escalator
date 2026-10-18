# Provider signal ingress

Provider requests use shared acceptance and source configuration in both hosts.
Standalone routes are under `/v1/ingest/providers`. Dashboard routes are under
`/<api-prefix>/v1/escalator/ingest/providers` (normally `/api/v1/...`). The existing
raw-body parser covers these routes, limits bodies to 256 KiB and rejects
compressed requests. Content type must be JSON with UTF-8 encoding.

| Provider mode    | Route suffix                    | Authentication                                                       |
| ---------------- | ------------------------------- | -------------------------------------------------------------------- |
| `sentry-hmac`    | `/sentry/<receiver-id>`         | `Sentry-Hook-Signature`, HMAC SHA-256 over original bytes            |
| `glitchtip`      | `/glitchtip/<source-id>`        | Scoped bearer token, or Basic user `escalator` and token as password |
| `grafana-bearer` | `/grafana/<source-id>`          | Scoped bearer token                                                  |
| `grafana-hmac`   | `/grafana-signed/<receiver-id>` | `X-Grafana-Alerting-Signature` plus `X-Grafana-Alerting-Timestamp`   |

Configure Grafana's timestamp header with exactly the name above. Its signature
covers `timestamp + ':' + body`; a missing timestamp or more than five minutes
of clock difference is rejected. Body transformations by proxies invalidate MACs.
Use HTTPS for remote provider delivery. Do not place bearer credentials in query
parameters or logs. Basic credentials must likewise be redacted by the proxy.

Standalone tRPC exposes `signals.createProvider`, `signals.updateProvider` and
`signals.issueReceiver`. Dashboard exposes `escalator.createProviderSource`,
`escalator.updateProviderSource` and `escalator.issueSignalReceiver`. Existing
source listing, editing, token issuance and revocation also apply. All application
procedures use the host's authenticated actor; payloads cannot select a tenant.

Signed source configuration takes an existing opaque secret ID, never a Vault
object name or plaintext key. Standalone decrypts through its configured AES-GCM
keyring after checking persisted receiver authority. The provider secret setup UI
and Sources screen are delivered with T3.11; these routes alone do not provide
that setup flow. Token modes require no secret binding. Signed modes use an
expiring public receiver ID and cannot issue bearer grants.

Sentry/GlitchTip issue notifications do not establish recovery. Their source
configuration requires manual recovery. Native GlitchTip receipt IDs distinguish
accepted observations, not provider retries; later grouping deduplicates pages by
stable issue fingerprint. Grafana supports per-alert firing/resolved transitions.
The signal processing handler is delivered in T3.4; accepting a notification here
does not by itself start paging.

## Dashboard integration prerequisite

The separate secret-store stack must supply organization-scoped metadata and
`DashboardSourceVerificationSecrets` on the existing paging binding's optional
`sourceVerification` field. Its authorization adapter resolves persisted source,
receiver and Vault version metadata, then rechecks the same grant and Vault
version after broker I/O. It uses the existing broker's `readForRedemption` method.
No new broker or secret table is introduced here.

A null paging binding or disabled organization rejects provider intake. Signed
receiver issuance also requires `sourceVerification`; existing generic/token
modes do not imply permission to decrypt an inbound verification secret. Metadata
checks must hold the scoped enabled-secret lock until the surrounding acceptance
transaction commits. The default Dashboard metadata adapter denies access.

## Runtime verification procedure

These checks require a separately authorized disposable installation and provider
configuration; they were not executed during implementation. No new infrastructure
is started by the unit tests.

1. Configure each mode and its source/service/environment through authenticated
   administration. For signed modes, provision an opaque verification secret
   through the host's authorized secret setup integration and issue a receiver.
2. Send a real provider notification and record a sanitized fixture with provider
   version and relevant header names. Never commit live MAC keys or bearer tokens.
3. Repeat Sentry/Grafana delivery and verify a duplicate response without a second
   processing job. Repeat native GlitchTip delivery and verify separate receipts
   with a stable fingerprint and no duplicate incident page once grouping is bound.
4. Tamper with raw bytes, signature, timestamp and source reference. Verify 401 or
   400 without exposing credential, organization or database details.
5. Revoke the receiver or disable its secret while verification is waiting for
   broker I/O. Verify no signal commits. Repeat during metadata-lock contention.
6. Send an oversized/compressed body and disconnect an unfinished request. Verify
   bounded rejection and no retained raw-body evidence in request diagnostics.
7. Confirm source edits, receiver issuance/revocation and accepted signals appear
   in the scoped audit trail, with no plaintext credentials or arbitrary payloads.
