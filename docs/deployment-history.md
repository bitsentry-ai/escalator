# Deployment history and persisted watch queries

The shared `DeploymentQueries` service exposes paginated deployment history and
persisted watch details to authenticated host sessions. Standalone provides
`deployments.history` and `deployments.detail`; Dashboard provides
`escalatorRouter.deploymentHistory` and `escalatorRouter.deploymentDetail`.
Both derive workspace and role from the current session. Request inputs cannot
supply either. Viewers, responders and administrators have deployment read access.

History requires a target ID, accepts a cursor and defaults to 25 records (maximum
100). It returns lifecycle records without the captured paging policy or token
credentials. Detail requires the target and deployment IDs and uses the same
scoped projection as the machine watch endpoint. Reads lock the target, validate
record ownership and do not run evaluators or create jobs.

Disabled targets remain visible to human readers. Machine polling still requires
a live scoped grant and an enabled target. Dashboard reads require organization
membership and rollout enrollment; they do not require an available channel
secret broker. This keeps recorded evidence inspectable during a paging outage.

A null watch means no persisted watch exists, not a passing release. Baseline
availability means a capture exists, not that its evidence is sufficient. The
shared deployments screen exposes these distinctions in both hosts. It shows
persisted verdicts, evaluation/finalization times, paginated evidence references
and gaps, overlapping releases, and the linked operational incident. Refresh
explicitly to read the latest persisted evidence; the screen never evaluates it. Coverage proof inspection continues through the existing
coverage query, which returns only the historical decision. Its evaluation and
override describe the accepted start; this read does not authorize a new start.

The feature tests cover pagination, cross-workspace isolation, disabled targets,
strict query inputs and rejection of incorrectly scoped adapter rows. Host router
tests cover session-derived actors, membership changes and logged-out callers.
No database, image, browser or provider runtime was started for this change.

## Screen verification procedure

With an authorized running host, open Deployments and select a target and release.
Check a tracking-only start, a successful finish with a pending watch, incomplete
evidence, a first failure linked to an incident, and a later healthy observation.
The first failure and incident must remain visible. Deployment success alone must
never display a passing health verdict. Inspect both baseline and watch evidence,
including later pages of references and gaps. Check an overlapping release and
incomplete overlap inventory: neither may imply certain causal attribution.

Inspect a start accepted with an override. Its recorded responder, reason and
proof expiry remain visible; the screen does not present that historical proof as
current authorization. A failed proof read must display an unavailable warning,
not a tracking-only claim. Switch organization while a detail request is pending:
no old release or follow-up proof request may appear in the new workspace. Open
the linked incident as a viewer and as a responder to verify host permissions.

These interactive browser checks remain not runtime-verified. Network-free DOM
unit tests exercise both authenticated client adapters, unavailable proofs and
an organization switch with a delayed response. Shared rendering tests cover
missing watches, incomplete evidence, bounded rows, escaped override text and
small nonzero error thresholds. Target and grant setup follows separately.

## Target and grant setup

Administrators can create targets, edit their policy and timeout, and inspect,
issue or revoke scoped deployment grants from the same screen in both hosts.
New targets start disabled. Service and environment cannot change after creation;
edits carry the last observed revision so concurrent changes are rejected.
Options and grant inventories load in pages, with explicit retry after errors.
When Dashboard paging is unavailable, targets can be staged disabled or disabled
and grants revoked; enabling targets and issuing writer grants remain blocked.

The issuer shows a bearer token once, held only in component memory. Copy it into
your deployment system's private secret storage before hiding it or navigating
away. Inventory reads contain metadata only. A failed issuance response can mean
that a grant was created: inspect the refreshed inventory and revoke unwanted
grants before issuing another. The UI never automatically retries issuance.
Revocation and target changes are still authorized and validated on the server.

Additional operator verification, not executed here: in each running host, use an
administrator and a viewer account; confirm only the administrator sees setup.
Create a disabled target, enable it with a valid policy, issue a read grant and a
writer grant mapped to an eligible responder, then follow the hook recipe.
Verify a competing edit rejects the stale revision, a revoked grant cannot poll
or write, and switching organizations removes a displayed token. In Dashboard,
repeat with the broker unavailable: stage disabled targets and revoke grants,
but do not enable a target or issue a writer grant. Confirm copy/hide on mobile.
DOM unit tests cover issuance uncertainty, tenant switches and role loss; these
are not a substitute for the running-host procedure.
