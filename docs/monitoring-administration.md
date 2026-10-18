# Monitoring credentials and ingress grants

These authenticated application APIs support the Sources and monitoring screens. They do not change machine-ingress authentication. Request bodies cannot select a workspace or organization.

## Grant inventory

Standalone exposes `signals.tokens`; Dashboard exposes `escalatorRouter.listSignalTokens`. Both accept `{sourceId, after?, limit?}` (default 25, maximum 100).

Only administrators can read the inventory. Results contain grant/source IDs, scope and creation, expiry and first revocation timestamps. Neither plaintext bearer tokens nor their hashes are returned. Signed receiver references remain available only from the existing issuance operation.

Pages use the same scoped source lock and indexed ordering in both adapters. Revoked and expired grants remain visible until retention removes them. Existing revocation procedures accept the listed grant ID and work without delivery/broker availability. A listed grant does not prove its source, service or verification secret is enabled.

## Standalone credentials

`monitoringSecrets.list` returns safe metadata from the existing encrypted store. `monitoringSecrets.create` takes a name and one write-only format:

| Kind               | Fields                                            | Stored representation                             |
| ------------------ | ------------------------------------------------- | ------------------------------------------------- |
| `http-probe`       | `header`: `authorization` or `x-api-key`; `value` | JSON with those fields                            |
| `metrics`          | `authorization`                                   | JSON with that field                              |
| `provider-signing` | `key`                                             | Raw UTF-8 bytes for Sentry/Grafana HMAC, not JSON |

Header values must be nonempty printable ASCII, at most 8,192 characters. Signing keys are nonempty valid text, at most 4,096 UTF-8 bytes. Names are bounded and reject invalid database text.

Creation requires the current administrator session. The existing AES-256-GCM writer binds encryption to workspace and secret IDs and records its redacted audit event atomically. Only the opaque ID and name leave the API. Owned encoding buffers are cleared on success and failure; JavaScript strings cannot promise immediate memory erasure. Values never enter jobs, audit metadata or source configuration.

A failed response can leave commit status uncertain. Check the metadata list before retrying creation. Never record values in request diagnostics. Typed creation and named selection in the UI follow this API part of T3.11.

## Dashboard integration dependency

D3 remains the separate secret-store stack. The existing `channelSecretOptions` binding can supply metadata to monitoring selectors, after authorizing both organization and actor.

Read-only inspection of `secret-store/13-lint-format` confirms `/credentials`, user-owned `CredentialsService.list/create`, and `WorkosVaultBrokerService.readForRedemption`. These are integration inputs, not proof of organization-ready Escalator provisioning:

- Resolve explicit organization ownership; membership alone cannot attach a user's credentials.
- Bind opaque IDs to immutable Vault generations and preserve revocation checks before and after broker I/O.
- Normalize approved bundles to the probe/metrics formats above. Inbound `sourceVerification` must return raw key bytes after checking persisted source/receiver authority.
- Supply an approved provisioning path for signing keys; the existing credentials page alone does not establish that capability.
- Return metadata without values. Missing bindings remain unavailable or deny access.

The broker stack is neither edited nor merged here. Dashboard activation and credential setup depend on completing this integration.

## Probe inspection

The existing probe detail query adds `lastResult`, resolved through the persisted state's observation ID in the same scoped transaction. It is nullable when no retained receipt is available. Its version can precede the current probe configuration; clients must display that distinction rather than imply that an older result validates new settings. History keeps its existing record-ID pagination.
