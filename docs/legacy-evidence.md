# Diagnosis evidence normalization compatibility

The shared investigation package now owns the existing diagnosis prompt's JSON
compaction, decoded Wazuh HTTP facts, provider query selection and prompt assembly. Worker exports remain
compatible and delegate to the compiled package. The package uses a structural
request snapshot and has no CE, WorkOS, Encore or backend dependency.

This extraction preserves the current security-telemetry behavior: character
budgets, query summaries, verdict instructions and string-only decoded HTTP
fields remain unchanged. Wazuh time windows/escaping and Sentry, PostHog and
GitHub selector priorities remain unchanged too. Worker source resolution/query execution, provider
selection and verification orchestration still belong to the worker.

The legacy compactor omits bulky payload fields; it is not a credential redactor.
Operational incident evidence must use the scoped, bounded and redacted
`EvidenceReader` path. Follow-up for the existing diagnosis flow: add explicit
credential-field/text redaction and regression cases before describing legacy
compaction as secret sanitization. This extraction does not change that behavior.

T5.3 remains partial until the scoped evidence readers and worker-side source
adapters are integrated. Moving these pure functions does not authorize a source,
prove a live Wazuh query or activate an operational investigator. Existing worker
diagnosis and Wazuh specifications remain unchanged and are the compatibility
gate, alongside package tests for compaction and decoded facts.
