# Scoped Wazuh investigation evidence

The operational worker reader implements `EvidenceReader` and delegates query
construction and evidence normalization to the shared package. It reuses the
existing Wazuh query helper with an explicitly supplied executor. There is no
fallback to the helper's global source resolver or ambient credentials.

A host must supply `WazuhEvidenceAccess`. It validates the live work claim and
source ownership/service/environment binding before invoking its callback once,
and rechecks revocation/generation before releasing the result. The executor
must cap raw response bytes before JSON materialization and support cancellation.
This authorization port has no permissive implementation. Backend grant/broker
composition and operational runner activation belong to T5.5; they are not
enabled by merely constructing an evidence query.

The credential-free binding specifies a source, revision, index pattern, exact
agent IDs and a timestamp field (`@timestamp` or `timestamp`). Shared code checks
all incident scope axes before constructing the query. The worker permits exactly
one `query_issues` action with that prepared query, limit and index pattern.
No request-supplied action, URL or arbitrary query language reaches the executor.

Results must carry real record/index identifiers, a selected agent and a valid
observed timestamp inside the requested window. Rows with missing provenance,
wrong agents/indices, duplicate identifiers or excessive counts are rejected.
Explicit timezone offsets normalize to UTC. `receivedAt` records when this read
first observed the row; it does not assert historical ingestion availability.
Evidence identifiers distinguish collected snapshots.

Projection includes selected rule, message and decoded HTTP fields. It does not
copy generic payloads, headers or credential objects. Oversized message/URL fields
are omitted whole before redaction, with explicit truncation flags. HTTP URL
fields with credentials, queries or fragments are masked, including relative
and protocol-relative forms. Shared
redaction and the validating reader remain the final model-input boundary. Empty
reads and unavailable sources remain explicit; they do not prove system health.

The existing security-telemetry diagnosis behavior and its specifications remain
unchanged. Tests use the real Wazuh query helper with fixture executors; the global
adapter is disabled in the new suite to prevent accidental external access.
Deployment requires the scoped host composition, not a mock or always-authorized
source binding.
