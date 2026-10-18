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
shared browser client exposes these distinctions; the deployments screen follows
in the next stack layer. Coverage proof inspection continues through the existing
coverage query, which returns only the historical decision. Its evaluation and
override describe the accepted start; this read does not authorize a new start.

The feature tests cover pagination, cross-workspace isolation, disabled targets,
strict query inputs and rejection of incorrectly scoped adapter rows. Host router
tests cover session-derived actors, membership changes and logged-out callers.
No database, image, browser or provider runtime was started for this change.
