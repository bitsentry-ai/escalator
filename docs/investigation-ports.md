# Investigation boundary

Investigations consume an incident's trusted workspace/service/environment scope.
They do not run on the paging critical path. These ports define the package seam;
this part does not enqueue or execute investigations in either host.

## Read-only evidence and model execution

An EvidenceReader accepts one configured source ID, evidence kind, UTC window and
row limit. A query window spans at most 24 hours. There is no arbitrary URL, SQL, shell or mutation tool. Adapters bind
source IDs to the incident's scope, apply destination policy, cancellation,
timeouts and response byte limits, and redact before returning text. References
carry observed/received timestamps and source identity. Unavailable sources are
explicit; an empty result must not disguise a failed read.

A ModelResolver resolves an administrator-configured profile ID in that scope.
Its result exposes provider/model and a credential-free destination origin, plus
one generation method. Profile credentials remain host-owned opaque secret
references. Models do not choose new credentials or destinations. Local versus
remote is an explicit configuration property, not a guess based on a hostname;
private networks can host local Ollama. No silent fallback is permitted.

Generation accepts bounded untrusted input separately from system instructions
and returns text plus usage. This same model port serves investigations and later
rule proposals; it has no automatic tool execution. The investigation orchestrator
validates model text as a strict plan containing only allowed evidence reads,
then checks the captured source allowlist and budget before executing a read. Reports cite supplied
evidence IDs, distinguish complete/partial/error/cancelled outcomes, and retain
unavailable sources. Schema bounds are a second line of defense; network
adapters must enforce transport limits before allocating a full response.

## Durability and isolation

Claim, heartbeat, trace append and report publication use host persistence.
Claims commit before external I/O. Runtime ID, workspace, claim token and live
database expiry fence every write, including the case where a lease expires
without a replacement claimant. Caller-supplied expiry is not authoritative.
Report scope and ID must match the claim; report publication and terminal state
commit together. Trace sequence retries are idempotent only for identical data.

The transaction-scoped intent writer will be used with incident creation, independently of
the initial page/outbox. Duplicate intent preserves the captured configuration. The worker bridge uses the backend's authenticated
runtime binding. Standalone uses its own in-process runner. Neither adapter
becomes another paging scheduler, and investigation outages cannot stop pages.

## Bounded execution

Budgets bound model calls, evidence reads and bytes, output tokens, trace events
and total monotonic duration. Wall-clock corrections cannot extend a run.
Cancellation is propagated to each operation, and adapters enforce their own
timeouts. Unknown provider token usage remains unknown; charge the reserved
output ceiling rather than claiming zero usage. Traces contain structured
metadata, never raw prompts, credentials or provider exception payloads.

Later parts implement and test these port guarantees: model creation and worker
compatibility (T5.2), evidence normalization (T5.3), bounded orchestration (T5.4),
fenced host persistence/consumers (T5.5/T5.6), and report UI/regression verification
(T5.7/T5.8). PostgreSQL and image procedures retain the documented runtime gaps.
