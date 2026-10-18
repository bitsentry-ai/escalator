# Deployment watch activation

Both hosts use the composed deployment repository for start, finish, timeout and watch work. New starts capture the baseline. The first accepted finish atomically creates the fixed 30-minute watch, evidence pins, evaluator job and cadence coordinator. Evaluations begin after one minute and continue through the existing two-minute receipt grace. Insufficient evidence stays explicit; a measured failure pages through the existing incident-correlation contract. No automatic rollback is performed.

## Runtime ownership

The in-process scheduler registers `deployment.watch` in a reserved lane and the three cadence job kinds in another reserved lane. Probe executions and metric polling retain their dedicated concurrency settings. There are ten reserved job workers, plus one when the watchdog is configured. Probe concurrency plus metric concurrency plus reserved workers must not exceed 64. The constructor rejects an over-budget configuration before starting any work; for example, 32 probe workers allow at most 22 metric workers without a watchdog, or 21 with one.

Cadence work uses the host's existing probe capacity limits. Eligible probes may temporarily run every minute. Immutable receipts and versioned ownership keep retries, overlapping watches and operator edits from restoring the wrong interval. Dashboard authenticated-probe changes use the same scoped broker metadata check as normal probe updates. Missing integration fails closed. No secret values are copied into watches or work payloads.

## Upgrade and runtime verification procedure

This procedure was not executed: no disposable PostgreSQL database, provider credentials or permission to start infrastructure is available in this task.

1. Apply all prior migrations, including baseline, watch and cadence storage, before activating these handlers. Avoid mixed old/new application versions: older schedulers do not know the new job kinds. Stop ingress and drain or stop old workers before replacing the application. Back up first.
2. Configure one disposable service with a probe above a 60-second interval, a valid paging contact and enough pre-deploy evidence. On Dashboard, integrate the separate secret-broker stack and enable the organization before accepting machine writes.
3. Start and finish a deployment. Confirm one baseline, watch and pair of initial job intents. Retry the same finish key and payload; verify no duplicate watch or page.
4. Confirm probe cadence tightens only within the configured capacity budget. Overlap a second deployment, then change a probe manually. Check that old restoration jobs preserve the operator's version and that overlap is reported as uncertain attribution.
5. Interrupt the process after finish and restart it. Confirm persisted work resumes, evaluates the original window and never admits observations received after its fixed receipt cutoff. A failed watch should link to one incident, including when normal detection runs concurrently.
6. Let the watch expire and verify an owned interval is restored, while a manually edited interval is preserved. Test missing evidence and verify an insufficient verdict rather than a pass.
7. Run both opt-in PostgreSQL conformance wrappers described in `deployment-watch-runtime-transactions.md`; use disposable non-superuser application roles and separate migration credentials.

Deployments already started before baseline capture was activated are not backfilled. Their missing baseline remains visible as insufficient evidence. Dashboard activation still depends on integration with the separate broker stack. Image inclusion, live timing and provider delivery remain unverified.

## Machine watch status

`GET /v1/deploys/:id/watch` on standalone and `GET /api/v1/escalator/deploys/:id/watch` on the Dashboard require `Authorization: Bearer <deployment grant>` with `deployment:read`. They do not accept browser-session, cookie or query-string authority. Each poll rechecks the live grant, target, service, expiry and organization. Missing or foreign deployments return 404 only after successful scoped authentication; invalid/revoked grants return 401. Reads have separate bounded admission (eight concurrent requests), with 429 and `Retry-After` when saturated.

The response contains `targetId`, the deployment lifecycle, `baselineAvailable` and the stored `watch`. A null watch means no watch has been persisted yet; it does not imply a pass. The recorded verdict, finalization time, evidence references and overlap inventory are returned without triggering evaluation. A failed or insufficient finalized watch stays distinguishable from success. Responses are non-cacheable. No routing policy, bearer credential, secret or provider body is returned. The Dashboard endpoint returns 503 until its broker binding is available.
