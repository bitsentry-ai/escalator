# Standalone watch cadence persistence

Migration `0020_watch_cadence.sql` adds one current ownership row per probe and an immutable receipt per deployment/probe. Composite foreign keys bind the probe, source, target, service, environment and owning deployment to the same workspace. Forced row security scopes reads and writes; application receipts have no update/delete policy.

`PostgresWatchCadenceRepository` composes probe, signal, deployment, paging, baseline, watch and cadence ports on one physical connection and transaction guard. Deployment and signal token ports remain separate. This adapter is not registered in the running application yet; Dashboard parity and worker-budget accounting precede activation.

The probe's capacity/target/source locks serialize ownership. Compare-and-swap updates require the expected revision and generation. Ownership deletion is fenced by both; immutable receipts survive deletion to prevent retrying an old application after an operator edit. Lease updates preserve the original interval and applied probe version.
