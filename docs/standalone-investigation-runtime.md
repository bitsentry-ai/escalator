# Standalone investigation runtime

The standalone runtime consumes `investigation.run` intents created with the first page. Its timer, concurrency limit and PostgreSQL pool are separate from the paging/API pool. It renews the current claim during evidence/model work, revalidates configuration and credentials, and publishes only under the live claim. Shutdown cancels local execution and leaves unfinished work reclaimable after lease expiry.

## Operator configuration

Execution is disabled until the deployment administrator supplies `ESCALATOR_INVESTIGATION`. A minimal same-host Ollama configuration is:

```json
{
  "enabled": true,
  "concurrency": 1,
  "pollEveryMs": 1000,
  "egress": {
    "hosts": [{ "hostname": "127.0.0.1", "ports": [11434] }],
    "privateCidrs": [],
    "allowLocalLoopback": true
  }
}
```

This example only applies when Ollama is reachable in the server process's network namespace. Container deployments must explicitly approve the actual model hostname, port and private range. There are no implicit hostnames, private-network grants, proxy settings or remote-provider fallbacks. Remote destinations require HTTPS and exact administrator-approved host/port entries.

Configure the service/environment's enabled investigation profile and selected sources in the application. The profile's displayed local/remote destination is used exactly as selected. Local Ollama can run without a provider credential. Other providers use the existing encrypted secret store through an opaque profile reference and a current investigation claim; credentials never enter queue payloads or reports.

The default poll interval is one second, with one active investigation. Administrator bounds are 250–60,000 ms and 1–4 active investigations. The dedicated pool has `2 * concurrency + 1` connections, a one-second acquisition limit and five-second statement limit; the repository also bounds each whole transaction to ten seconds. Include those connections alongside the API/paging and retention pools when configuring PostgreSQL capacity. A slow model never borrows a paging connection or paging job slot. Metadata uses shared read locks compatible with paging foreign-key checks; an opt-in PostgreSQL test verifies that compatibility with a second connection.

Retained probe, metric, alert and deployment evidence uses the captured query windows. External logs/git require separate explicitly scoped bindings. Missing evidence is unavailable, not healthy. A profile/source revision change or revocation invalidates an old capture; a local model failure produces an incomplete result instead of switching providers.

## Verification procedure

Run the feature and server suites and the standard Escalator build/typecheck/lint checks. Unit cases cover consumer concurrency/shutdown, fixed configuration errors and local execution/failure without network requests. Opt-in PostgreSQL cases require the disposable database configuration described in the existing investigation storage procedure. No test database or live Ollama endpoint was available during implementation; PostgreSQL concurrency, model connectivity and startup/shutdown are not runtime-verified. Do not interpret those gaps as passing runtime checks.
