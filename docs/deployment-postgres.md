# Standalone deployment persistence

The standalone adapter implements the shared deployment transaction contract on
PostgreSQL. It adds targets, hashed grants, deployment/routing snapshots and
immutable command receipts. Machine ingress and runtime deadline handlers are
separate parts; this adapter does not activate them.

## Migration and privileges

Build the workspace, then use the existing `db:migrate` command with the migration
role's `ESCALATOR_MIGRATION_DATABASE_URL`. Migration `0016_deployments.sql` is
additive; keep prior migration checksums unchanged. Apply schema changes before
activating callers of the new repository.

The restricted runtime role needs SELECT, INSERT and UPDATE on
`escalator_deploy_target`, `escalator_deploy_grant` and `escalator_deployment`.
It needs SELECT and INSERT only on `escalator_deploy_receipt`. Keep existing
foundation, configuration, work and audit privileges. Do not grant receipt UPDATE
or DELETE, table ownership, superuser status or BYPASSRLS. Use the deployment's
actual schema and role identifiers when granting privileges.

All four tables force row-level security. The application transaction sets the
trusted workspace ID. Authentication lookup uses a transaction-local exact-token
hash exception on the grants table, projecting only workspace, target and grant
IDs. That SELECT-only policy does not authorize writes or reads of other tables.
The application must still validate capability, expiry and revocation under the
target lock before processing or replaying a command.

## Transaction behavior

Target reads lock their row, including starts whose deployment row is absent.
Natural keys, composite foreign keys and conditional revisions supplement shared
validation. Routing-policy reads stay on the same connection and transaction.
SQL values are bound; table and column choices are a closed internal set.

The adapter uses a five-second statement timeout and one-second lock timeout.
These are per-statement bounds, not a measured end-to-end deadline. A failure
rolls back deployment, receipt, work and audit writes together. No network call
belongs inside the callback. Paging latency under contention still needs runtime
measurement in the hardening phase.
