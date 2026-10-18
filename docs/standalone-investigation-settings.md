# Standalone investigation settings

The authenticated `investigationSettings` tRPC router exposes `get`, `create`,
`update`, `sources` and `createSecret`. It derives workspace and responder identity
from the local session. Shared use cases restrict writes to administrators;
viewers and responders may read configuration and source metadata. Credential
creation requires secret-management permission and returns only its ID and name.

Choose a service/environment, list source options by evidence kind, and create one
profile with an explicit destination, endpoint, limits, selected sources and
enabled state. Default forms to disabled. Updates require the current profile ID
and `expectedRevision`; reload on conflict. Raw keys belong in `createSecret`,
never in a profile or URL. Local secretless Ollama accepts a null secret ID. No
provider connection is made while settings are stored.

Native source options currently cover probes, normalized alert intake, metric
monitors and deploy targets. All queries filter by workspace, service and
environment, with per-kind pagination. Inactive sources remain visible as
inactive. External log and repository-diff connections require their explicit
connection adapters and ownership links; they are not inferred from ambient
credentials or enabled by this part.

## Storage and authorization

Migration `0022_investigation_settings.sql` adds a unique selected profile per
service/environment and normalized source links. An update commits the profile,
links and audit together. Reads aggregate the profile and links in one statement
so concurrent updates cannot produce mixed versions. Shared validation rejects
scope changes and stale revisions. Mutable source and secret metadata are locked
before authorization; probe/metric parents are locked before their child rows.

The application database role needs SELECT, INSERT and UPDATE on
`escalator_investigation_settings`, and SELECT, INSERT, UPDATE and DELETE on
`escalator_investigation_source_link`. Both tables force row-level security. Do
not give the application a superuser or BYPASSRLS role. The test fixture grants
these privileges only inside its random disposable schema.

Settings use the existing foundation transaction with a five-second statement
timeout and one-second lock timeout. It has no provider or broker network calls.
The separate investigation execution repository retains its dedicated bounded
pool/transaction contract; these settings APIs do not activate a runner.
