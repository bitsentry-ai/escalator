# Investigation leases and publication

The shared claim coordinator wraps the read-only investigation engine for both hosts. Host adapters authenticate the runtime and workspace before claiming work. Shape validation alone grants no authority: every heartbeat, trace write and publication must check the persisted runtime, token, scope and database expiry after acquiring the relevant locks.

## Execution lifecycle

Renew the claim before any evidence/model work begins. Continue renewal while the engine awaits providers. A missing, malformed, timed-out or failed heartbeat stops execution and prevents publication. Network/model waits do not hold the claim transaction open.

Default leases last 30 seconds, renew every ten seconds, and bound heartbeat/publication waits to five seconds. Hosts must also set physical database and transport deadlines. Racing a promise cannot stop a port that ignores cancellation. The engine enforces its own duration budget; the coordinator allows one second for it to return a terminal partial report before abandoning an unresponsive engine.

Runtime shutdown aborts local work and ends renewal. It does not publish a terminal user-cancellation result: the durable intent remains available for another runtime after lease expiry. An explicit user cancellation is an authenticated persistence operation, distinct from process shutdown.

## Result boundary

Before publication, validate the report and redacted snapshots against the captured claim: matching scope and ID, exact evidence references, configured source/query windows, provenance, serialized byte accounting and resource ceilings. Missing or truncated evidence cannot be presented as a complete result. The host additionally validates the configured model destination against its persisted configuration and the live claim fence. Validation cannot prove that a model's diagnosis is true.

Persist report, snapshots and terminal job state atomically. Return `published` only for a confirmed successful transaction. A false publication fence means `lease_lost`. An exception or timeout means `publication_unknown`: the transaction may have committed before the response was lost. The coordinator never retries a publication or model call automatically. Reclaim logic must inspect durable state and bound total attempts; the worker's local result is not proof of publication.

Stop renewal after completion and dispose timers/listeners on every exit. Callers log outcome metadata only, not the report/evidence body or exceptions containing credentials. Paging has separate capacity and does not await this coordinator.

## Dashboard machine boundary

The internal `POST /api/worker/escalator-investigations/claim` route accepts only `workspaceId` and `runtimeId`. The heartbeat, result and trace routes add `/:id/heartbeat`, `/:id/result` and `/:id/trace` respectively and require the current `claimToken`. Result and trace requests carry `result` or `event`. These are machine-ingress exceptions to the Dashboard's tRPC application API.

`WorkerAuthGuard` authenticates the WorkOS service key. The injected host binding must separately authorize that authenticated key for the requested organization and runtime. The default binding is null, so requests cannot claim work until the integration is configured. The rollout organization allowlist does not substitute for worker authorization. Dashboard activation depends on integrating the existing secret-broker stack and worker ownership mapping; this part neither duplicates nor merges that stack.

Raw JSON is bounded to 1 MiB before parsing; compressed bodies are rejected. The controller generates claim tokens, reloads the persisted claim for subsequent calls, validates result/trace metadata and maps failures to fixed codes without raw exceptions. Persistence must still fence every operation atomically, including changes after `readClaim`; this controller is not a substitute for database fencing. Trace sequences must fit captured budgets and cannot carry arbitrary prompts. Persistence must reject conflicting duplicate sequences and accept identical retries idempotently.

Controller unit tests exercise the boundary without starting HTTP servers. Actual PostgreSQL adapters, worker polling and standalone composition remain subsequent T5.5/T5.6 work. No end-to-end worker execution or database conformance is claimed here.
