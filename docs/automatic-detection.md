# Automatic detection activation

Both hosts register the same `signal.process` and `signal.recover` handlers beside
paging handlers. Processing, recovery, paging deadlines, provider receipts and
cancellation each have an independent job lane; slow intake cannot occupy the
paging deadline lane. This uses the existing PostgreSQL scheduler, not Redis.
Constructing either runtime does not start it; the host owns lifecycle hooks.

An administrator explicitly binds a service/environment pair to an enabled,
reviewed escalation policy before relying on automatic pages. The standalone
application API exposes `detection.getBinding` and `detection.configureBinding`;
Dashboard exposes `getDetectionBinding` and `configureDetectionBinding` under its
existing Escalator tRPC router. Both reject client-selected tenant IDs. Creation
uses `expectedVersion: null`; edits use the last returned version. Binding changes
and their audit entry commit together. Source setup screens follow in T3.11.

Dashboard requires its organization rollout and the existing secret-broker stack's
integration before automatic paging can be enabled. Disabled configuration can
still be saved. Standalone uses the local account role and workspace.

A missing or disabled binding/policy causes processing to fail visibly rather than
consume an accepted event without paging. Existing job retries are bounded; failed
work remains persisted. Operator redrive and detection-health presentation remain
subsequent integration work. Do not treat successful HTTP acceptance as successful
paging, and do not enable sources before configuring their binding.

Verification here uses pure handlers, in-memory conformance, host construction and
tRPC identity tests. No listeners, schedulers against a real database, providers,
Docker images or Encore images were run. PostgreSQL runtime validation still needs
the documented disposable database configuration.
