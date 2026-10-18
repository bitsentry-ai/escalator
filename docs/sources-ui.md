# Signal source administration

The Sources screen is shared by standalone Escalator and Dashboard. Readers can inspect source configuration; administrators can create generic, Sentry, GlitchTip and Grafana sources, edit grouping/recovery, disable intake and rotate credentials or grants. Probe, heartbeat and metrics sources remain owned by their monitor editors.

A source is bound to one service and environment at creation. All requests use current host identity; no editable tenant field exists. Updates include the selected configuration version. A conflict or uncertain response requires refresh before retrying. Every configuration or grant write uses the existing transactional audit path.

Sentry and GlitchTip issue notifications require manual resolution. Silence is never recovery. Disabling intake does not resolve incidents that already exist. Fingerprint grouping can include multiple sources only when explicitly selected.

Signed sources use named signing-key references. Standalone can create the raw write-only signing key separately from source creation. Dashboard depends on the separate broker integration for organization ownership, provisioning and verification authority. Saving a reference does not establish that integration.

Grant inventory displays metadata only. Issue a replacement before revoking an old grant. Bearer tokens are shown once after successful issuance; signed sources receive a public routing reference whose use still requires a valid MAC. Values remain only in component memory and are cleared on dismissal, navigation or source/client changes, with no browser-storage writes. JavaScript memory cannot promise immediate erasure.

Configure the external provider using [provider signal ingress](provider-signal-ingress.md) and [generic signal ingress](generic-signal-ingress.md). Use the deployment's actual external origin and API prefix. The UI never places bearer credentials in links, query parameters or persisted settings. An uncertain issuance response may have created a grant whose value was not received; list and revoke that grant before issuing another.

Creating a source alone does not enable paging. A service/environment detection binding must explicitly select an enabled escalation policy. The shared Automatic paging section configures that binding from a selected source or probe. Heartbeat and metrics screens remain subsequent T3.11 work.

Unit checks cover strict form mapping, selection-owned IDs/versions, signed versus token formats, bounded input, escaped read-only rendering and host transport mapping. No live browser, provider or database was used. In an authorized disposable environment, create each provider mode, edit with a stale version, rotate/revoke grants, switch organization while a request is pending, and verify reader controls and audit records. Real provider delivery and Dashboard broker activation remain unverified.
