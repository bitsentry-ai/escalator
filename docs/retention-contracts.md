# Replay retention and coverage contracts

This first retention part defines validation and evidence coverage only. Database recording, pruning, scheduled maintenance, host APIs and screens arrive in subsequent parts of T3.12. No history is deleted by these functions.

## Retention target

The shared policy defaults to 30 UTC days and a 5 GiB normalized-payload maintenance target per workspace. Hosts must enforce their configured capacity ceilings when accepting policy changes. This is an operational default, not a measured capacity promise. Protected operational references may prevent reaching the target; report that pressure rather than deleting active state. Logical payload bytes exclude PostgreSQL indexes, WAL, audit records, backups and other database overhead. Raw provider bodies are not retained by the current ingestion adapters and are outside replay payload accounting.

The policy calculation accepts database time supplied by the scoped transaction. Expiration is strictly before the computed cutoff. Byte pressure is computed separately from age. A record is eligible only after the adapter proves it is not needed by a current state pointer, live job, pending detection, or required metric preroll. A negative or inconsistent usage snapshot is rejected. The pure calculation does not claim that pruning has run or succeeded. The batch planner examines at most 1,000 candidates belonging to one locked source, selects at most 100 eligible records in observed-time order, and leaves protected rows untouched. Cross-workspace/source candidates, duplicate identities and inconsistent accounting fail closed. The host must atomically apply the selection, idempotency tombstones, terminal dependencies and byte accounting; returned pressure is a prediction until that transaction commits.

## Periodic evidence

Coverage reports identify algorithm version 1 and use half-open UTC ranges and immutable configuration segments. Each enabled segment supplies its schedule anchor, cadence, revision and original recording time. The adapter must provide a complete manifest for the requested range, including disabled periods. Current configuration must never be projected backward into unknown history.

Each receipt identifies its scheduled slot, original observation time, availability time, configuration revision and whether its normalized evidence is usable. For a slot, the newest receipt available by the snapshot cutoff wins; equal receipt times use descending ASCII ID order. Unknown availability is retrospective, never simulated contemporaneous evidence. Missing interior slots, unusable samples, disabled intervals and unknown/unavailable configuration remain visible. A truncated query invalidates coverage for the whole requested range. One hundred thousand slots and receipts bound a single calculation; callers must request smaller windows when needed.

The snapshot cutoff is not a replay engine. A later replay must independently filter evidence and configuration at every simulated decision time. A coverage report never asserts service health. Existing probe outcomes cannot prove a newly proposed HTTP assertion because historical response bodies are not retained.

## Event-driven evidence

Webhook sources have no promised sample cadence. Their report counts visible, late and retrospective events and states that continuity is not inferred. An empty event history cannot be labeled healthy, a clean negative, or continuous monitoring. Incomplete reads remain explicitly incomplete.

## Adapter obligations

Both PostgreSQL adapters must scope every receipt and configuration query to the authenticated workspace (Dashboard organization ID). They must return complete bounded pages or mark the report incomplete, preserve observation and receipt times, and report retention boundaries rather than reconstructing deleted data. Pruning must preserve ingress idempotency after replay payloads are removed.
