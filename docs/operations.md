# Operating Escalator

## Recovery assets

Back up PostgreSQL with a consistent database snapshot and retain every encryption
key referenced by that snapshot, including inactive keys required for old TOTP
secrets. Store the keyring separately from the database backup, with restricted
access and an offline recovery copy. Preserve the image digest, migration ledger,
non-secret deployment configuration, provider credential recovery instructions,
and the external watchdog configuration. A database dump without its keys is not
a usable recovery backup. Do not put key material or connection URLs in tickets.

Keep application and migration database roles separate. The runtime role must
not own tables or bypass row security. The migration role is an offline operator
credential. Restoring object ownership and privileges is part of recovery; a
successful restore by a superuser does not prove the runtime role works.

## Pending paging before planned interruption

Inventory open incidents, pending/running paging and outbox work, delivery attempts
with unknown outcomes, active deployments, and investigation/proposal leases. Give
an operator a copy of incident identifiers and due times without acknowledgement
bearer tokens. Notify the independent on-call contact before stopping dispatch.

Either complete pending work, or explicitly hand responsibility to that operator
with a recorded acknowledgement. Do not mark work delivered or cancel pages merely
to empty a queue. Stopping the process alone is not a safe handoff. An in-flight
provider request can have succeeded despite a lost response; inspect provider
receipts before manual redelivery and expect duplicates where delivery is uncertain.

Keep the external watchdog enabled. If its maintenance mode is used, set a bounded
expiry and appoint an independently reachable operator. Escalator must not monitor
its own outage as the only notification path.

## Backup and restore rehearsal

1. Record the source image digest and migration checksums. Produce a consistent
   PostgreSQL backup with restricted output permissions; record its checksum and
   timestamp. Securely copy the matching keyring and configuration separately.
2. Restore into an isolated disposable deployment with outbound providers disabled
   by network policy. Never run restored paging alongside the live dispatcher.
3. Restore roles and grants, mount keys with owner-only permissions readable by the
   application UID, and use the original schema-compatible image initially.
4. Verify account login/MFA, encrypted provider secret resolution, incident history,
   acknowledgement handling and pending work recovery using designated test
   contacts. Check for unknown provider outcomes and expired leases.
5. Verify authenticated readiness, stalled-dispatcher failure and the independent
   watchdog notification before authorizing a live cutover.
6. For disaster cutover, fence the old deployment from the database and outbound
   providers before starting dispatch in the restored deployment. Record the data
   loss window and reconcile incidents/deployments created after the backup.

These steps require operator runtime authorization. Build success is not evidence
of restore correctness or a measured recovery-time objective.

## Upgrade and rollback

Prepare immutable old/new image digests and a fresh database/key backup. Review
additive migration compatibility with the previous release; never edit applied
migration SQL. Standalone migration execution is explicit through the migration
CLI, and is not part of ordinary application startup. Apply the complete migration
chain with its separate role, then update restricted runtime grants.

Before replacing dispatchers, use the paging handoff above and stop new claims.
Wait for bounded in-flight operations to drain; after an unclean stop wait for
leases to expire before assuming another worker can take ownership. Do not erase
lease rows or reset attempt counters to speed recovery. Start only a compatible
artifact, check authenticated readiness, then exercise a designated test incident
and independent watchdog before resuming ordinary ingress.

An application rollback retains the additive schema and requires an explicitly
compatible older artifact. Do not reverse migrations or restore an old database
under running workers. If compatibility is unknown, keep dispatch handed off and
repair forward. A database restore is a separate disaster-recovery cutover with
potential data loss, not an ordinary application rollback.

Document operator, timestamps, image digests, migration ledger, readiness results,
pending-work disposition and the outcome of the test notification for every change.
