# Deployment grants and commands

The shared application layer manages deployment targets and expiring machine
grants. Hosts supply authenticated actors for administration and an explicit
workspace allowlist for machine access. This part does not activate HTTP routes,
preflight, stuck-deploy paging or health watches.

Administrators create one target per service/environment, select a routing policy
and configure the trusted timeout. Target edits use conditional revisions. Enabled
targets require an active policy and service. Responder mapping is selected during
grant issuance and must identify an enabled, scoped responder who can acknowledge
pages. Hook-supplied actor text never changes that mapping.

Grants have independently selected `deployment:read` and `deployment:write`
capabilities. They expire after 30 days by default, with a 60-second minimum and
90-day maximum. Rotation issues a replacement before revoking the old grant.
Issuance returns the random bearer secret once, after the grant and audit commit.
Only its SHA-256 digest is stored; inventory and audit omit both secret and digest.

Every machine operation validates the token again under the target lock, including
receipt replays. Disabled targets/services, revoked or expired grants, denied
workspaces and insufficient capabilities fail before the command callback runs.
Read permission does not grant write permission; callers needing both must request
both capabilities. Machine request bodies never select a workspace.

Start and finish validate strict versioned inputs after authentication. A canonical
hash binds an idempotency key to the action, route deployment ID and normalized
body. Reusing that key with different content fails without overwriting its receipt.
An exact retry returns the original committed result, even if the deployment has
since finished or the caller has rotated to another valid grant on the same target.
The original deployment mapping, grant and deadline remain unchanged.

Lifecycle state, immutable receipt and redacted audit commit atomically. An audit
failure rolls everything back; an identical retry can then succeed. Rejected
lifecycle events also receive a bounded receipt and audit result, except
chronology rejections: they depend on database time, so they are audited without
a receipt and an identical retry is evaluated again. Missing-start
finishes never fabricate a deployment. Late finishes retain a persisted timeout
while recording the eventual outcome.

The read helper returns deployment state; it does not infer a health-watch verdict
from deployment success. Preflight decisions, timeout jobs and watch evidence are
added by their later use cases. Host routes must add bounded ingress admission and
sanitized transport errors when activating these commands.

The feature unit suite exercises authorization, redaction, rotation, replay,
concurrency, expiry, scope isolation and rollback using the test-only transactional
adapter. PostgreSQL conformance and runtime contention remain separately documented
opt-in checks; no database or application is started by these tests.
