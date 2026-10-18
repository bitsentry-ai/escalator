# Investigation persistence

Standalone investigations use the existing PostgreSQL durable-job table and three new tables: captured investigation configuration/report, redacted evidence snapshots, and structured trace events. The investigation ID is also its job ID. A composite foreign key restricts that job to `investigation.run`; it cannot be attached to paging or maintenance work.

## Host composition

Construct `PostgresInvestigationRepository` with a separate bounded investigation pool and an explicit `InvestigationDatabasePolicy`. There is no permissive authorization fallback. Policy callbacks run inside short transactions: lock mutable runtime ownership, profile and source-binding rows until transaction end, and do no network I/O. The configuration callback returns the current model profile, opaque approved secret IDs and source-binding versions for the exact incident scope.

Use `repository.writer(client, workspaceId)` inside the existing incident/page transaction. It must not outlive that transaction. The convenience `enqueue` method owns a separate transaction and is for compositions where incident creation is already committed; it is not the atomic first-page integration. Duplicate intent keys retain the original captured configuration. No credentials or Vault object names belong in job payloads.

Capture model and source versions at enqueue. A changed profile cannot silently replace the model for waiting work, and changed bindings invalidate an active claim. Live secrets still require the secret store's generation/revocation checks before and after resolution. Capturing configuration is not authorization to read a secret.

## Durable execution

Claim, renewal, trace and publication acquire locks in investigation-then-job order and use database time for lease checks. Runtime, token, attempt and captured scope/configuration must match; caller expiry metadata grants no authority. Reclaims increment persisted attempts, with a default limit of three and a configurable maximum of five. When next considered for a claim, exhausted or changed-configuration work becomes failed, not completed. An active configuration change first prevents further renewal or publication. Human status queries must expose that state even when no report exists.

Publish the terminal job state, report and redacted snapshots in one transaction. A rejected or expired claim cannot write a result. Trace sequences are scoped to each claim attempt, so a reclaimed run starts its own trace without overwriting prior evidence. Identical trace retries are idempotent; conflicting content for the same attempt and sequence is rejected. Human reads require the exact workspace, incident, service and environment scope.

A ten-second deadline bounds connection acquisition, callback work and commit together. Queries also have five-second statement and one-second lock timeouts. A deadline destroys the connection rather than returning a running transaction to the pool. A connection arriving after timeout is destroyed without starting work. A commit reply lost at timeout remains uncertain; callers must inspect durable state and must not retry model execution automatically.
