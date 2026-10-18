# Durable watch cadence jobs

The shared jobs are not registered in either host yet. Both hosts need the cadence storage adapter/migration, a composed deployment/probe transaction and worker slots within the existing global ceiling before activation.

The finish job fans out the captured probe inventory in deterministic batches of at most eight. Each transaction writes at most eight probe jobs and one successor batch. Replaying a batch does not duplicate child jobs. Only captured probes are considered; a missing baseline or expired watch cannot begin new tightening.

Each probe job takes capacity, target, source/probe and ownership locks before fencing its persisted work claim. It checks an immutable application receipt before acting. A changed configuration version after capture supersedes a delayed first application; a current owned lease is the only exception.

Both tightening and overlapping extension require a fresh check against configured capacity. If limits were reduced, an overlap cannot extend the old faster interval beyond its existing deadline. A skipped application gets a receipt and an explicit skipped audit event.

A successful change updates the actual probe/source versions, retained configuration history and schedule, then stores ownership, queues restoration and records the receipt/audit in the same physical transaction. The original interval is retained across overlaps. Probe, source and work operations use the namespaced probe context without replacing deployment-token methods.

Restoration checks the current generation, lease revision, probe version and deadline under the same lock order. Each ownership revision queues its own restoration job, so an overlap supersedes the old job and re-arms restoration even if an earlier job failed terminally. A manual edit supersedes ownership even if it retains the same numeric interval. Successful restoration reschedules the longer interval; superseded restoration leaves the operator's configuration untouched. Receipt or audit failure rolls back all effects, including restoration work.
