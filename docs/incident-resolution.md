# Incident resolution and the Dashboard bridge

Both hosts resolve through the shared incident use case. The page lock serializes acknowledgement and resolution. Page state, the incident timestamp, cancellation intents and one audit event commit together. A retry returns the first resolution without changing ownership or emitting another event. In-flight provider responses retain their attempt history; cancellation uses the existing durable provider jobs.

Standalone tRPC exposes `incidents.resolve({ id })`. Dashboard exposes `escalator.resolveIncident({ id })` for an Escalator ID and `escalator.resolveDashboardIncident({ id })` for its linked Dashboard ID. Both use the authenticated organization and the same shared operation. Administrators and enabled responders may resolve; viewers may read only. Resolution remains available when dispatch is disabled so existing pages can be closed.

## Dashboard ownership and D5

New Escalator incidents create an `OPERATIONAL` Dashboard incident and an organization-scoped link in the same PostgreSQL transaction. No bridge event is sent back into incident creation. The bridge never claims an arbitrary legacy incident based on the reader's identity. Existing Escalator incidents have explicit organization ownership and are backfilled by the migration; unrelated legacy incidents remain unlinked. If an older host creates an owned record after the migration backfill during a rolling upgrade, its first resolution creates a new scoped bridge record inside the locked transaction. It never claims an existing legacy row.

The migration creates one system reporter per existing Escalator organization and installs a trigger for new workspaces. Its nullable email, WorkOS ID, role and status remain null under a database constraint. Reporter organization ownership cannot be removed or reassigned. WorkOS login requires a linked WorkOS ID and an allowed status; these reporter records cannot acquire either. A missing or login-capable reporter causes incident creation to roll back.

Use the two tRPC resolution entry points for linked records. They take the page lock first and synchronize the Dashboard row in the same transaction. Direct SQL edits and independently implemented status writers are outside this contract; future Dashboard status actions must call the bridge instead of writing a linked record directly.

D3 remains separate: Dashboard dispatch and manual incident creation require integration of the existing secret broker stack. This change neither copies that broker nor infers credential organization ownership.
