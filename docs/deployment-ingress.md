# Deployment machine ingress

Both hosts expose the same shared command implementation:

| Operation | Standalone                    | Dashboard (default prefix)                  |
| --------- | ----------------------------- | ------------------------------------------- |
| Start     | `POST /v1/deploys/start`      | `POST /api/v1/escalator/deploys/start`      |
| Finish    | `POST /v1/deploys/:id/finish` | `POST /api/v1/escalator/deploys/:id/finish` |

Send `Authorization: Bearer <deployment grant>`, `Content-Type: application/json`
and `Idempotency-Key: <stable command key>`. Use a different key for start and
finish; reuse the original key and body after a lost response. Bodies follow the
versioned deployment contracts. Responses contain a deployment ID and persisted
lifecycle state, or a bounded error code. A successful finish is not a health
verdict. Watch reads arrive with the post-deploy watch implementation.

Browser administration remains authenticated tRPC: standalone `deployments`
procedures and Dashboard `listDeploymentTargets`, `getDeploymentTarget`,
`createDeploymentTarget`, `updateDeploymentTarget`, `deploymentGrants`,
`issueDeploymentGrant`, `revokeDeploymentGrant`. The current session supplies
workspace/organization identity; request bodies cannot override it. Target
administration requires the shared administrator capability. Grants are scoped
to one target with separate read/write capabilities; read-only grants cannot
start or finish. Grant issuance returns its bearer once. Inventory is redacted.

Dashboard target activation and writer-grant issuance require the existing
paging/broker binding. Machine commands return unavailable until it is installed,
and the organization's Escalator rollout must be enabled. Disabled target drafts,
read-only inventory and grant revocation remain available to authorized users.
This dependency does not integrate the separate secret-store stack.

Raw request parsing runs before broad parsers, rejects compression and caps
bodies at 8 KiB. Incomplete bodies have the existing ten-second read timeout.
Each host process admits at most eight deployment commands, with no waiting
queue. Excess operations return 429; unavailable storage returns sanitized 503.
Those responses include `Retry-After: 1`. An admitted operation retains its slot
until the database call settles; no timeout races pretend to cancel database work.
These limits do not claim isolation from the shared database pool or an overall
transaction/network deadline. Capacity and transport-failure proof remain runtime
checks for the hardening phase.

All responses disable caching. Controllers remove raw evidence from the request
before executing commands. The transport never echoes exception messages or
bearer credentials. A 202 records acceptance, 200 a lifecycle duplicate, and 409
a rejected lifecycle transition or conflicting idempotency key. An exact receipt
retry preserves its original result and status, including an original 202.
