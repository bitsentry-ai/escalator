# Manual incidents and detail APIs

Both hosts call `IncidentUseCases` from their authenticated tRPC adapters.
The standalone namespace is `incidents`; Dashboard procedures live under
`escalatorRouter`. Hosts derive the actor and workspace from current identity.
Request schemas reject caller-supplied workspace and role fields.

Administrators and responders have `incident:create`; viewers can only read.
Environment creation uses the existing administrator-only `service:manage`
capability. Environment list/create is included because incident records require
an environment and a new installation otherwise has no way to configure one.

Manual creation accepts a stable request ID, service, environment, stored policy
ID, title and severity. The selected policy must be enabled for that service.
Policy selection, incident/page insertion, deadlines and responder-attributed
audit share one repository transaction. Retries with the same content return the
same page; conflicting content is rejected. Existing pages keep their frozen
policy even if the configured policy changes or is disabled later.

Dashboard creation returns `PRECONDITION_FAILED` while its trusted secret-broker
binding is absent. Reading existing incidents and configuring environments remain
available to authorized users. This prevents creating pages that its inactive
runtime cannot dispatch. Standalone creation similarly rejects disabled policies.

Detail responses contain the incident, owner, page state and ladder timeline.
The policy contract bounds the timeline to 121 entries, fetched in at most two
scoped queries. Delivery lists are limited to 25 rows per request, with five
initial attempts per delivery. Each continuation is explicit; the attempts API
also checks that the delivery belongs to the requested incident.
No response exposes stored secret IDs, contact bindings, claim tokens, provider
receipt IDs or acknowledgement grants. The incident UI follows in a later part.
