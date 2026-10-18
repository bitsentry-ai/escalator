# Probe management and capacity

The shared `ProbeManagement` use case creates, edits, disables and reads probes
using the authenticated host actor. Only administrators can write; responders and
viewers can read. Inputs cannot choose a workspace, source ID or version. Service,
environment and source ownership stay immutable after creation.

Creation starts disabled unless explicitly enabled. An enabled probe must pass
the deployment administrator's exact destination policy. The policy receives the
trusted workspace ID, so Dashboard must use organization-specific allowlists.
One organization's private destinations must never become a shared tenant allowlist. Authenticated probes
require HTTPS. Configuration, its owning source, scheduled work and a redacted
audit entry commit together. Edits use the expected version and replace the old
scheduled job. The generic source API cannot change internal probe, heartbeat or
metrics sources; their owning features control those lifecycles.

A disable operation remains available after destination rules or capacity limits
are tightened, and while an existing secret is unavailable. Enabling or changing a
secret binding requires valid scoped metadata. No resolved secret, URL, request
body or response body enters the configuration audit metadata.

## Deployment limits

Defaults are 100 active probes, 500 configured probes and four probe workers.
Limits are deployment configuration, never fields in a probe request. The host
must supply the same concurrency value to management and the dedicated
`probe.execute` scheduler lane when activating the feature.

Management locks workspace capacity before source/probe rows and holds that lock
through the configuration commit. Both PostgreSQL adapters use a scoped
transaction advisory lock. Concurrent creations therefore cannot both consume the
last capacity slot. The shared conformance suite includes that race.

The configured request budget sums `ceil(timeoutMs / intervalSeconds)` across
enabled probes and limits it to `concurrency × 800`. These are milliseconds of
configured request time per second, rounded up. This reserves nominal 20% headroom
for polling/database overhead: 100 one-minute probes with one-second timeouts fit
the default budget; 100 probes with ten-second timeouts do not. Disabling is never
blocked by an over-budget deployment.

This is an admission bound, not a measured support envelope or a guarantee about
actual network/database performance. Runtime queue lag and missed observations
need health reporting and load validation.

The scheduler permits 1–32 workers for an explicitly dedicated single-kind job
lane, with at most 64 job workers per scheduler. Other job lanes retain their own
workers. Tests hold probe requests open and verify that paging deadlines still
run. Outbox behavior is unchanged. Host/global organization capacity and actual
runtime activation follow in subsequent work.
