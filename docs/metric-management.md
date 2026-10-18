# Metric monitor management

Only administrators with `service:manage` can create, edit or disable monitors;
viewers and responders can inspect configuration and observation history.
Identity and scope come from the host session. Request input cannot select an
organization, source ID or network policy. New monitors default disabled.

Configuration edits require the current version. They atomically update the owned
internal source, append an immutable configuration snapshot, cancel the old intent,
create the next intent and append audit metadata. A new version starts a fresh
sample window: old observations remain available for historical replay but cannot
contribute to its live verdict. Disabling cancels polling without asserting recovery.

Enabled destinations must match trusted deployment policy. Credentialed requests
require HTTPS and opaque secret IDs. Errors and audit metadata exclude query text,
URLs and credentials. Disabling remains available when credentials or destination
policy become unavailable.

The default limits are 100 active and 500 configured monitors, with four dedicated
polling workers. Operators may configure up to 1,000 active, 10,000 configured and
32 workers. Scope-wide capacity locks serialize admission. The budget assumes ten
seconds per query pair and reserves 20% for transaction and loop overhead. These
are conservative admission limits, **not measured capacity**. Paging and heartbeat
deadline lanes retain their own workers. Both hosts register the dedicated lane.

Trusted `MetricDeployment` input uses `{destinations:{hosts:[{hostname,ports}],
privateCidrs:[]},limits:{maxActive,maxConfigured,concurrency}}`. Missing configuration
denies all network destinations. Invalid settings fail with a redacted error.
Never source these settings from application requests. Both host route and runtime
composition select the same trusted deployment settings.

## Host activation

Standalone uses `ESCALATOR_METRICS` for trusted deployment JSON. Its authenticated
tRPC `metrics` router exposes `list`, `get`, `history`, `create`, `update` and
`disable`. The in-process scheduler registers `metrics.poll` independently of
paging, signal processing and heartbeat deadlines.

Dashboard uses `ESCALATOR_METRIC_ORGANIZATIONS`, a JSON object whose keys are
rolled-out WorkOS organization IDs and values use the deployment shape above.
At most 64 organizations and 64 configured metric workers are accepted per
process. An organization without settings gets a deny-all policy and one worker
to drain existing jobs as unavailable. Each organization's combined scheduler
also rejects more than 64 job workers across all lanes.

The Dashboard Escalator tRPC router exposes `listMetrics`, `getMetric`,
`metricHistory`, `createMetric`, `updateMetric` and `disableMetric`. It resolves the
trusted actor before choosing limits. Enabled writes require the separate broker
binding; missing integration does not start any polling runtime. Disabled monitors
can be inspected and configured without enabling polling. A non-null secret ID
still requires broker metadata to prove ownership, even on initial disabled drafts.

Example standalone policy (operator must replace the approved hostname):

```json
{
  "destinations": {
    "hosts": [{ "hostname": "metrics.example", "ports": [443] }],
    "privateCidrs": []
  },
  "limits": { "maxActive": 10, "maxConfigured": 50, "concurrency": 4 }
}
```

Credentials are opaque secret IDs; the configured encrypted store/broker releases
plaintext only for the persisted live job claim. Network I/O uses the same DNS
pinning and destination policy as probes. Query windows use immutable configuration
versions and database receipt visibility. PostgreSQL execution, live provider
queries and measured capacity remain not runtime-verified in this environment.
