# Deployment watch runtime transactions

Both hosts use a runtime repository that composes deployment coverage, baseline capture, finish watches, timeout jobs, probe cadence and incident correlation on one physical transaction. See [activation and upgrade procedure](deployment-watch-activation.md) for handler registration, worker limits and runtime verification gaps.

Start captures the baseline and its pins before enqueueing the timeout. The first accepted finish creates its watch, pins, evaluation job and cadence coordinator together. Rolling back the finish removes all of those effects. Probe changes, receipts and restoration work use the same transaction protocol. Deployment and signal token interfaces remain separate.

Watch evaluation locks captured sources before detection groups, pages and work claims. Incident correlation uses the existing detection ports without replacing deployment-token methods or manufacturing a signal. The evaluator does not take the global probe-capacity lock; only cadence changes do.

## Overlapping deployments

Attribution is uncertain when another deployment's execution or its following 30-minute watch overlaps the current watch. An earlier finish does not establish sole attribution while that earlier deployment's watch is still active. A deployment without a finish receipt visible at the snapshot stays open-ended until it times out. Its recorded timeout then ends its execution window, and its following 30-minute window applies, so a deployment that timed out long ago does not mark every later watch as uncertain.

Reads are scoped by workspace/organization, service and environment, exclude the watched deployment, and fetch at most 129 rows. The result retains 128 IDs and explicitly reports incomplete inventory on overflow. A held target lock serializes deployment lifecycle writes for that service/environment. The shared validator rejects foreign scope, duplicates, self-reference and impossible chronology.

Receipt visibility is capped at the evidence snapshot and the original watch end plus its 120-second grace period. A delayed worker cannot include a newly accepted, backdated deployment or a finish receipt beyond that cutoff. Overlap is correlation, not proof of cause; it does not replace measured health or trigger rollback.
