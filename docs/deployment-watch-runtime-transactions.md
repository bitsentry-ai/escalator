# Deployment watch runtime transactions

Both hosts now have an unregistered runtime repository that composes deployment coverage, baseline capture, finish watches, timeout jobs, probe cadence and incident correlation on one physical transaction. Runtime registration follows separately so a live finish cannot queue a kind that the running scheduler does not handle.

Start captures the baseline and its pins before enqueueing the timeout. The first accepted finish creates its watch, pins, evaluation job and cadence coordinator together. Rolling back the finish removes all of those effects. Probe changes, receipts and restoration work use the same transaction protocol. Deployment and signal token interfaces remain separate.

Watch evaluation locks captured sources before detection groups, pages and work claims. Incident correlation uses the existing detection ports without replacing deployment-token methods or manufacturing a signal. The evaluator does not take the global probe-capacity lock; only cadence changes do.

## Overlapping deployments

Attribution is uncertain when another deployment's execution or its following 30-minute watch overlaps the current watch. An earlier finish does not establish sole attribution while that earlier deployment's watch is still active. A deployment without a finish receipt visible at the snapshot stays open-ended until it times out. Its recorded timeout then ends its execution window, and its following 30-minute window applies, so a deployment that timed out long ago does not mark every later watch as uncertain.

Reads are scoped by workspace/organization, service and environment, exclude the watched deployment, and fetch at most 129 rows. The result retains 128 IDs and explicitly reports incomplete inventory on overflow. A held target lock serializes deployment lifecycle writes for that service/environment. The shared validator rejects foreign scope, duplicates, self-reference and impossible chronology.

Receipt visibility is capped at the evidence snapshot and the original watch end plus its 120-second grace period. A delayed worker cannot include a newly accepted, backdated deployment or a finish receipt beyond that cutoff. Overlap is correlation, not proof of cause; it does not replace measured health or trigger rollback.

## Verification

Shared unit cases cover overlapping completed watches, unknown unfinished deployments, overflow, invalid identities and fixed receipt visibility. The same opt-in PostgreSQL suite runs in both hosts and checks atomic start/finish effects, usable cadence work, whole-finish rollback and scoped overlap reads.

No disposable PostgreSQL configuration is available here. Database cases are delivered but not runtime-verified. Configure the existing explicit test database variables described in each host's cadence-storage guide, then run the standalone server suite and Dashboard Escalator Jest suite. They start no servers or infrastructure. Live scheduler activation and timing still require the next runtime-registration change and an equipped environment.
