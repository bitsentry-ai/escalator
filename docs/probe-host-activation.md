# Probe host activation

Probe configuration and execution use the shared package in both hosts. Application APIs are authenticated tRPC. Probe forms cannot approve network destinations or choose tenant scope.

## Standalone

Set `ESCALATOR_PROBES` to deployment-owned JSON before starting the application through the supported deployment procedure:

```json
{
  "destinations": {
    "hosts": [{ "hostname": "api.example.com", "ports": [443] }],
    "privateCidrs": []
  },
  "limits": { "maxActive": 100, "maxConfigured": 500, "concurrency": 4 }
}
```

Omission denies every destination. Exact hosts/ports are required even for public addresses. Private destinations require both a host entry and a CIDR approval; platform metadata and special-use addresses remain denied. Use the HTTP probe policy guide for network restrictions and synthetic-write requirements. Configuration parsing reports a static error rather than printing environment contents.

The local authenticated `probes` router exposes `list`, `get`, `history`, `create`, `update` and `disable`. Shared authorization restricts writes to administrators. Create defaults to disabled. Enabled writes validate destination policy and capacity inside the configuration transaction. The scheduler claims `probe.execute` independently of paging, signal processing and recovery.

## Dashboard

Set `ESCALATOR_PROBE_ORGANIZATIONS` to a JSON object keyed by enrolled WorkOS organization ID. Each value has the standalone configuration shape. Every key must also occur in `ESCALATOR_ENABLED_ORGANIZATIONS`. Do not share a private-host allowlist across organizations.

```json
{
  "org_example": {
    "destinations": {
      "hosts": [{ "hostname": "api.example.com", "ports": [443] }],
      "privateCidrs": []
    },
    "limits": { "maxActive": 100, "maxConfigured": 500, "concurrency": 4 }
  }
}
```

Each organization receives its own destination policy and management limits after the WorkOS session resolves to an actor. Configured probe concurrency sums to at most 64 HTTP workers per backend process. This is not a cluster-wide quota or a measured throughput guarantee. Database claims fence jobs across processes.

Missing organization configuration uses one deny-all worker to drain previously scheduled probes into unknown observations without network requests. Removing approval never produces a successful observation or silently marks recovery. Disabling a probe cancels its pending schedule through the normal audited API.

Dashboard activation still requires the separately integrated secret broker binding. Without it, no monitoring runtime starts and enabled configuration writes are rejected. This stack does not install a replacement broker.
