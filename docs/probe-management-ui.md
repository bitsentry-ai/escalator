# HTTP probe management

Both hosts expose the same **Probes** screen alongside Services, Incidents and On-call. The host supplies its authenticated tRPC client and identity. The shared UI never selects a workspace or accepts organization IDs as authorization.

An administrator can create, edit, enable and disable probes. Other enrolled users can read configuration and observations. Every write is authorized again by the server, uses the current configuration version, and records a redacted audit event in the same database transaction.

## Configure a probe

1. Create the service and environment first. Use the paginated selectors to load additional entries when needed.
2. Choose **New probe**. Enter the destination, method, interval, accepted status codes and any response assertions. New probes are disabled by default.
3. For JSON assertions, supply an array such as `[{"path":["status"],"operator":"equals","value":"ok"}]`. Property names and array indices form the path. Numeric comparisons support `gte` and `lte`. HEAD requests cannot assert a response body.
4. A POST requires its JSON body, an explicit test marker path/value, an idempotency header supported by the endpoint, and cleanup guidance. Read methods send no body. Never put credentials in URLs or request bodies.
5. An authenticated probe references an existing encrypted HTTP authorization secret by ID and requires HTTPS. Credential provisioning remains host-owned; the UI does not read or persist plaintext credentials.
6. Review and save the disabled configuration, then enable scheduled requests. Enabling is subject to the deployment's destination policy and capacity budget; a screen cannot relax either.

A critical route alerts on its first failed observation. Other probes use the chosen consecutive failure and recovery thresholds. Unknown observations remain visibly unknown; they do not imply recovery.

Selecting a probe shows its version, last configuration update and paginated observations, including outcome, reason, HTTP status when available, duration and probe version. Configuration changes are audited by the existing management use cases. The list follows the API’s stable record-ID pagination; it does not promise chronological order or identify the latest observation. It is not a replacement for the host’s audit log.

If a save conflicts with another administrator's change, refresh the list and select the probe again before editing. Disabling uses its own versioned operation and remains available when deployment destination policy has become more restrictive.

See [deployment setup](probe-host-activation.md), [management contract](probe-management.md) and [HTTP policy](http-probe-policy.md). Sources, heartbeat and metrics configuration screens are delivered in subsequent T3.11 parts.

## Disposable-environment acceptance procedure

Not runtime-verified in this implementation environment; do not run against production.

- In each host, create a service and environment, then create a disabled GET probe for an operator-approved test endpoint.
- Confirm no request is scheduled while disabled. Enable it and observe a successful run. Check that the configuration audit contains the authenticated actor and scoped probe ID without credentials.
- Change the endpoint response to violate an assertion. Confirm the documented threshold opens one incident; restore it and check the recovery threshold and hold.
- Disable the probe and confirm the audit event and cancellation of its scheduled work. A request already in flight may finish; it cannot commit a stale configuration result.
- Open two administrator sessions on the same version. Save in one, then try saving in the other; expect a conflict without overwriting the newer configuration.
- Repeat read-only access with a viewer and verify forged write calls are rejected. In Dashboard, switch organizations and verify drafts and observations do not carry over.
- Exercise POST only against a disposable endpoint with idempotency support and a tested cleanup procedure. Verify the marker and request key, then clean up the synthetic data.

Unit coverage checks form safety, immutable update identity/version, critical thresholds, read-only rendering, escaping and standalone tRPC procedure mapping. Build and seam checks cover both host consumers. Live UI, network, PostgreSQL and Dashboard broker execution remain separate runtime checks.
