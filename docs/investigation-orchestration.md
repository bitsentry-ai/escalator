# Bounded investigation execution

The shared runner reads a captured list of source queries and requests one structured diagnosis. It exposes no model-selected tools, arbitrary URLs, SQL, shell commands or mutation operations. Evidence is untrusted context, separate from the system instruction. Host authorization and source response limits remain mandatory even when the shared reader validates the result.

## Budgets and cancellation

Each run snapshots its limits, scope and queries. A monotonic clock measures duration; wall time only labels reports. Integer resource charges reject over-budget updates without changing counters. Output tokens are conservatively reserved at the configured ceiling, including when a provider reports lower or unknown usage. This is accounting, not a billing estimate.

Every asynchronous host port is raced against cancellation and a deadline. Hosts must still propagate the signal to their database/HTTP implementations: abandoning a promise cannot physically stop an implementation that ignores it. Per-operation waits are at most two minutes; total duration is at most ten minutes. Database lease expiry remains authoritative independently of these clocks.

Evidence bytes include serialized metadata and text, and are checked before and after redaction. The complete model context is capped at 256 KiB. The report preserves unavailable sources, omissions, token-limited output and unknown completion metadata as partial outcomes. With no usable evidence, no model is called. Unattempted queries remain visible when a budget, cancellation or lease loss stops work.

## Output and trace

Only strict JSON containing a summary and cited findings is accepted. Unknown fields, duplicate citations and references absent from the validated snapshots are rejected. The scoped model resolver also masks echoed API keys while the secret callback is active and rejects oversized or truncated responses. Summary and finding text are redacted before publication; source projection remains essential because heuristics cannot discover every secret in prose. A token-limited response never becomes a completed report even if its JSON parses.

Trace writes contain structured metadata, reference IDs and usage only. They carry the claim's scope, runtime and token; the host must reject a stale/expired claim and conflicting duplicate sequence. A rejected trace stops the run. The model has no trace or repository access.

The runner returns the report plus redacted evidence snapshots. Host adapters must persist both atomically under a live claim fence. A report reference alone is insufficient to reproduce what the model saw. Human evidence reads must authorize the same workspace/service/environment/incident scope. Paging runs independently and must not wait for these reads, model requests or report writes.
