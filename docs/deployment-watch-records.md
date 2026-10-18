# Watch decisions and historical evidence

This layer defines watch records, shared transitions and transaction-bound evidence readers for both hosts. It does not persist watch records or activate watch jobs yet. Baseline persistence already exists; watch persistence, post-watch pins, bounded probe tightening/restoration, atomic incident integration and route registration remain prerequisites for T4.5 completion.

## Decisions

Every recorded completion can produce a separate 30-minute watch beginning at its server receipt time. This includes successful, failed and cancelled deployments, and a late completion after timeout. A timeout without a finish does not masquerade as a completed deployment.

Healthy partial evidence remains `PENDING`. A final healthy/warning verdict requires the full watch plus the two-minute receipt grace. Missing baseline, missing captured streams or incomplete evidence yields `INSUFFICIENT_DATA`. One known failed stream can establish `FAIL` even when other inventory is incomplete.

The first failed evaluation is retained independently of the latest stream results. Later healthy samples cannot erase it. The incident link cannot change once assigned, and final decisions cannot be overwritten by subsequent receipts. These invariants currently apply to the shared transition API; database enforcement and atomic incident creation follow with the persistence/orchestration layer.

Overlap inventories are bounded to 128 deployment IDs. The first evaluation may establish a complete inventory; subsequent overflow or incompleteness remains visible. Overlap and a failed watch establish correlation only. There is no automatic rollback or promotion gate.

## Historical reads

Readers use the baseline's captured source inventory. New monitors added after deployment start do not retroactively gain a baseline. A captured monitor disabled after the watch window remains readable; current enabled state must not erase its earlier observations.

Compare the historical measurement definitions selected for the watch window against the captured baseline fingerprints. A later definition change outside that window does not invalidate an otherwise compatible history. An incompatible change inside the window remains insufficient evidence. The baseline and watch reuse the same configuration-segment construction and receipt-selection rules.

The PostgreSQL queries exclude receipts unavailable at the fixed grace cutoff before applying the bounded receipt limit. A late correction cannot displace an earlier receipt that was available by that cutoff. Unknown legacy receipt timing remains unusable evidence. Each query remains bounded to 128 streams and 128 configurations/receipts per stream, with explicit completeness flags; serialized watch records are capped at two million characters.

Both readers validate organization/workspace, target, deployment, service and environment bindings before SQL. They run on the caller's scoped transaction, lock captured sources in stable source-ID order, and acquire those locks before work/accounting locks. They do not resolve credentials, contact providers or start another transaction.

## Paging and verification

The policy helper requires a recorded failure. Watch paging retains the captured service schedule ladder, unlike timeout paging's deployer-first ladder. Generated watch policy metadata identifies the accepted deployment. Disabling new intake must not erase an already accepted failed watch's page. Actual paging activation waits for atomic watch/incident persistence.

Run the feature suite for watch transitions, first-failure preservation, finalization, missing evidence, overlap bounds, historical compatibility, late receipts and scope binding. Existing baseline cases exercise the shared projection refactor too. Both host builds/typechecks validate reader consumption through compiled package exports.

PostgreSQL reader execution and concurrency are not runtime-verified here: no disposable test database is configured. The full watch integration suite must additionally check disabled-after-window sources, post-window definition edits and more than 128 late receipts before runtime activation. Docker/Encore and Dashboard broker integration gaps remain unchanged.
