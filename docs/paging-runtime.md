# Paging runtime integration

Both hosts register the shared paging handlers against PostgreSQL durable work.
Each organization/workspace has independent polling loops for `paging.step`,
`paging.receipt`, `paging.cancel`, and the `paging.send` outbox. Receipt network
latency therefore does not occupy the step runner. Polling uses a five-second
interval and batches of ten; this is scheduling configuration, not a measured
latency guarantee. Provider I/O runs outside repository transactions.

Nest application bootstrap starts the loops. Module destruction drains them
before database shutdown. Claims, retries, acknowledgements, and provider outcomes
retain the existing database fencing and idempotency rules across restarts.

## Standalone

The paging module supplies the configuration repository, encrypted secret store,
and public HTTPS channel transport. `ESCALATOR_PUBLIC_URL` provides the externally
reachable acknowledgement origin and is validated by startup configuration.
Secret authorization reads the persisted work kind and payload: known paging
operations require one matching `approvedSecretIds` entry. The legacy `secretIds`
convention remains limited to non-paging work. Neither convention accepts secret
IDs supplied independently by a worker request.

## Dashboard broker dependency (D3)

Dashboard paging remains inactive while `DASHBOARD_PAGING_BINDING` is null; the
access response reports `pagingAvailable: false`. Services remain available for
organizations enabled by the existing rollout configuration.

Integration with the separate `secret-store/*` stack must replace that provider
with `dashboardPagingBinding(broker, authorization, metadata, publicUrl)`. The
broker implements redemption; authorization validates organization ownership,
active work claims and approved secret IDs; metadata checks enabled provider
credentials within the same trusted organization. Existing broker credentials
are user-owned, so their IDs alone do not establish organization ownership.
Do not enable paging using a permissive metadata or authorization callback.
The binding is server-owned and cannot be supplied by application requests.
