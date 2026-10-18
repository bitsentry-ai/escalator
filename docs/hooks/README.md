# Protected deployment hooks

These recipes call the same machine API in both hosts. `hook.mjs begin` checks coverage and submits a start carrying the returned proof. It exits nonzero on blocked, malformed, unavailable or unconfirmed responses. Only run the actual deployment after this command succeeds. `hook.mjs finish SUCCEEDED` records a confirmed deployment completion; it does not claim that the independent post-deploy watch passed.

Copy `hook.mjs` and `client.mjs` together into your deployment repository. They use Node 22 built-ins, require a Unix runner and need no package installation. They never invoke your deployment tool themselves. Read the [Kamal](kamal.md), [Coolify](coolify.md), [Dokploy](dokploy.md) or [GitHub Actions](github-actions.md) recipe before enabling a hook.

## Configuration

Provision a deployment target, routing policy and scoped machine grant first. Map the grant to the actual deployer: the JSON actor is informational and cannot impersonate a responder. The grant needs `deployment:write`; add `deployment:read` only when the same integration should poll watch status.

Supply these environment variables through the runner's secret/configuration mechanism:

| Variable                | Meaning                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ESCALATOR_URL`         | API base ending in `/v1/deploys` for standalone or `/api/v1/escalator/deploys` for Dashboard                   |
| `ESCALATOR_TOKEN`       | Scoped deployment bearer grant; never a shell argument or committed file                                       |
| `ESCALATOR_STATE`       | Dedicated private path for one deployment attempt, e.g. a `session.json` inside a new private runner directory |
| `ESCALATOR_SOURCE`      | Stable integration name, such as `github-actions`                                                              |
| `ESCALATOR_RUN_ID`      | Unique deployment attempt, including retry/attempt identity                                                    |
| `ESCALATOR_ENVIRONMENT` | Target environment ID                                                                                          |
| `ESCALATOR_ACTOR`       | Informational actor name                                                                                       |
| `ESCALATOR_COMMIT`      | Immutable commit, or empty when only an artifact identifies the release                                        |
| `ESCALATOR_ARTIFACT`    | Immutable artifact reference, or empty when the commit identifies the release                                  |

At least one commit or artifact reference is required. HTTPS is mandatory except for loopback HTTP in an explicitly configured disposable manual test. Dashboard requires organization enrollment and integration with the separate secret broker.

```sh
# Existing environment/secret configuration supplies the variables above.
node ./ops/escalator/hook.mjs begin
# Run the deployment and verify its specific release completed successfully.
node ./ops/escalator/hook.mjs finish SUCCEEDED
```

A successful `begin` prints only the deployment ID. A 200 preflight response can still block; the helper requires an explicit allow decision and proof ID. It does not request overrides or fall back to tracking-only starts. An authorized human can review coverage and issue an override through the host application; a hook cannot silently override it.

## Retries and uncertain outcomes

The private state file stores intent, timestamps, proof and idempotency keys before network writes. It never stores the grant. Retry the same command with the same state, source, run ID and release after a transport failure. The helper resends the original body and key. It makes at most three transport attempts, each with a ten-second timeout, and rejects redirects. It does not renew an expired proof or rewrite a finish outcome.

Each state directory must be private to the current Unix user. A sibling `.lock` prevents concurrent invocations. After a crash, first verify that no hook process is running and reconcile any potentially accepted deployment. Only then remove that session's stale lock and retry. Do not delete the intent merely to bypass an expired proof or an ambiguous start. Create a new attempt only after reconciling the old one.

A deployment request being queued is not a finish. Record `SUCCEEDED`, `FAILED` or `CANCELLED` only from a confirmed terminal result for that exact provider deployment. If the runner disappears or the outcome remains uncertain, leave the deployment open; its durable deadline will page. A failure to report a finish must fail the CI step and be reconciled rather than ignored. These scripts do not roll back a release.

## Manual verification, not executed here

No server, provider deployment or new test infrastructure was started while implementing these recipes. PostgreSQL and end-to-end hook timing remain not runtime-verified. Run the following only in your separately authorized disposable environment, using each recipe and both hosts:

1. Configure a target with a mapped deployer, an awake scheduled peer, working paging contacts and probes. Use the correct host API base and a disposable grant.
2. Run the recipe. Confirm one start, one finish and one 30-minute watch for the same release. Verify the provider's terminal result independently; a queued response is insufficient.
3. Remove declared peer coverage and run a fresh attempt. Verify nonzero exit **before** the deployment command/trigger. Repeat with a missing broker binding, revoked grant, timeout and malformed response. None may proceed with deployment.
4. Interrupt the helper after sending a start but before receiving its response. Preserve the state, reconcile and retry. Confirm the same idempotency key/body and no duplicate deployment. Retry finish and confirm one terminal event and one watch.
5. Try a contradictory finish outcome and confirm local rejection. Use an expired proof and confirm a blocked start rather than automatic proof replacement.
6. Stop the runner after start. Confirm durable timeout paging; do not manufacture a successful finish to silence it.
7. Poll `GET <base>/<deploymentId>/watch` with a read grant. Check non-cacheable responses, revoked-grant rejection, explicit pending/insufficient results and the incident link on failure. A successful provider deploy alone must not produce a passing health verdict.
8. Record the tool/server versions, exact recipe, observed provider deployment ID, Escalator deployment ID and outcome. Store no credentials in the verification record.
