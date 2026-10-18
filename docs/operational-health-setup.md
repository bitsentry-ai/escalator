# Operational readiness and an independent watchdog

Both hosts expose process liveness separately from operational readiness. Liveness only confirms that this HTTP process responds. Readiness reads scoped queue ages and the actual scheduler's progress. It returns 503 while work is overdue, a lane is stalled, the database is unavailable, or the Dashboard broker integration has not supplied a runtime.

| Host       | Liveness                        | Authenticated readiness                           |
| ---------- | ------------------------------- | ------------------------------------------------- |
| Standalone | `/health/live`                  | `/health/ready`                                   |
| Dashboard  | `/api/v1/escalator/health/live` | `/api/v1/escalator/health/<organizationId>/ready` |

Dashboard paths above assume the default `api` prefix; use the configured API prefix in deployments that change it. These are explicit health HTTP routes, not browser application APIs. Browser sessions, cookies and query-string tokens grant no readiness access. Responses are not cached. Dashboard’s existing rate limits still apply; stagger checks across organizations rather than polling every organization in one burst.

## Readiness credential

Generate a fresh 32-byte capability on the operator's machine and keep its HTTP header in a private file. This example refuses to overwrite an existing file and prints only the hash used in deployment configuration:

```sh
node --input-type=module <<'JS'
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const token = randomBytes(32).toString('base64url');
writeFileSync('escalator-readiness.header', `Authorization: Bearer ${token}\n`, {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({readinessTokenSha256: createHash('sha256').update(token).digest('hex')}));
JS
```

Set standalone `ESCALATOR_HEALTH` to that JSON object. For Dashboard, `ESCALATOR_HEALTH_ORGANIZATIONS` maps each enabled WorkOS organization ID to its own object. Configure separate credentials per organization. Unknown or disabled organizations are rejected at startup; at most 64 entries and 64 KiB of JSON are accepted. Missing readiness configuration leaves the endpoint unauthorized, including for logged-in administrators.

Optional `limits` fields are `queryTimeoutMs`, `maxSchedulerAgeMs`, `maxPagingLagMs` and `maxJobLagMs`. Defaults and bounds are enforced by the shared deployment configuration. The default limits are 5 seconds, 60 seconds, 60 seconds and 5 minutes respectively. Tighter query budgets can intentionally fail readiness before the database adapter's own limits expire.

A monitor can read readiness using the protected header file without putting its token in command-line arguments:

```sh
curl --fail-with-body --header @escalator-readiness.header https://your-escalator-host/health/ready
```

Use HTTPS and the Dashboard organization route when monitoring that host. Rotate readiness credentials by replacing the trusted digest and updating the monitor's protected header file. Never add the token or header file to source control.

## Outbound watchdog

Create a write-only webhook credential through the host's existing secret-management path. It contains the external watchdog's HTTPS URL and optional bearer token. Add `watchdog: {"secretId":"<opaque credential ID>","intervalSeconds":60}` to that workspace or organization's health configuration. The destination itself never enters environment configuration or durable job payloads. Intervals may be 30–300 seconds. Omitting `watchdog` disables outbound delivery; it does not disable readiness.

The runtime owns both the normal scheduler and the watchdog coordinator. Construction opens no connection and starts no timer. Startup begins them through the host lifecycle. Shutdown marks scheduler progress inactive and stops both loops. Watchdog delivery uses the same encrypted-secret and public HTTPS transport boundaries as paging, including claim fencing, pinned public DNS, verified TLS, no redirects and bounded response reads.

The watchdog adds one scheduler job lane and must fit the existing 64-worker job limit. Over-budget configurations fail construction. It sends only after fresh readiness passes, after secret access, and after rechecking the persisted claim. Failed checks suppress the heartbeat. Delivery uncertainty is not reported as successful. A request already transmitted cannot be recalled if health degrades afterward.

Configure the external watchdog to notify someone independently of this application. Allow startup grace while every lane completes its first database operation and a current interval is processed. Complete configuration changes across all replicas: configuration-specific job kinds prevent replicas from consuming one another's intents. Cleanup of expired intents left behind by removed configurations is tracked under T3.12; this activation change does not provide that retention job.

Dashboard activation remains dependent on integration of the separate secret broker stack, including organization and durable-claim authorization for the opaque credential. A configured readiness credential cannot manufacture an available runtime when that binding is absent.

## Verification procedure and current gaps

Unit tests cover shared authorization, organization isolation, HTTP status/header mapping, module providers, inert construction and lifecycle registration. Database adapter conformance is described in [database-health.md](database-health.md). Those PostgreSQL cases remain skipped until an existing disposable test database is configured.

In an authorized disposable deployment, check that liveness remains 200 when the database is unavailable while authenticated readiness becomes 503. Verify that an overdue paging row fails readiness and stops external heartbeat delivery. Restore database access and allow scheduler progress to resume, then confirm readiness and subsequent heartbeat delivery recover. Stop the whole application and confirm the independent watchdog alerts without relying on an Escalator page. Exercise both hosts, including a foreign organization's token and a disabled broker binding.

Live HTTP endpoints, PostgreSQL behavior and outbound watchdog delivery have not been runtime-verified here. No server or infrastructure was started for this change. Container/Encore image verification and capacity measurement remain separate environment-dependent procedures.
