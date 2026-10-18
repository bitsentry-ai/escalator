# Incident screens

Both hosts use `IncidentsScreen` from the compiled feature package. Standalone exposes Services and Incidents after local login; Dashboard exposes the same choices inside its existing Escalator route, subject to organization rollout.

Administrators and responders can create incidents when paging is available. Choose an enabled service, an environment and an active policy. The form keeps its request ID when an unchanged submission is retried after a failed or lost response. Changing the fields starts a new request. Administrators can create environments; refresh the environment choices after creation. Schedule and policy editing follow in the on-call screen slice.

Selecting an incident shows the frozen ladder timeline, acknowledgement owner and delivery attempts. Incident lists, configuration choices, deliveries and attempts have explicit pagination. Unknown provider outcomes are displayed as unknown. Use Refresh to fetch current state; this screen does not claim to stream updates.

Resolution refreshes the incident detail and list. It is available independently of new dispatch activation, so an existing page can be closed while paging is disabled. Viewer controls are read-only, and both hosts still enforce capabilities on the server.

The host supplies its authenticated transport and resets the shared screen when the authenticated workspace changes. No workspace identifier is sent as an application authorization input. Pending results from an unmounted workspace screen are discarded. The UI consumes the safe attempt projection, without secret IDs, receipt credentials or work-claim tokens.

Dashboard creation remains dependent on D3 broker integration. Its tRPC adapter uses Dashboard sessions; the standalone adapter uses the existing session and CSRF transport. Neither screen initializes acknowledgement capability handling; that isolated route remains separate.

## Verification

The interaction suite renders the same timeline fixture through each host's client adapter. It also covers unchanged-request retries, resolution refresh, attempt pagination and stale workspace responses. The standalone transport has an additional unit test. Six locales pass the shared namespace gate.

No live browser or server was started. Visual checks against a deployed host and PostgreSQL-backed interaction remain operator checks, alongside the migration/conformance procedure in [incident resolution](incident-resolution.md).
