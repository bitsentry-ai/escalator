# Deployment baseline storage

T4.5 remains partial. This layer adds the shared capture contract and a standalone PostgreSQL adapter; it does not register that adapter in the deployment runtime. Dashboard parity, watch state/jobs, probe tightening and failed-watch incident creation must precede activation in both hosts.

An accepted start and its baseline must commit together. Capture retains actual probe outcomes and metric counts for the 15 minutes before the declared deployment start. The server records the capture cutoff; retrying an accepted start never refreshes that snapshot. A late hook cannot reconstruct evidence that was already pruned. Receipts without a known configuration revision or scheduled time cannot establish scheduled coverage. Empty or incomplete baselines are valid records but cannot establish a successful watch.

The bounded database reader admits at most 128 streams, 128 configurations and 128 receipts per stream. The saved contract additionally limits aggregate receipts to 8,192, configuration segments to 4,096 and serialized snapshot characters to 2,000,000. Database readers use an extra row to detect truncation. Truncated queries and a concurrently created source outside the locked inventory remain explicitly incomplete; exceeding a saved-record bound aborts the start transaction.

Only outcomes, counts, timestamps, criteria and measurement fingerprints enter baseline history. URLs, request bodies, queries and credential references remain in the configuration tables. Hosts use the shared measurement-field list and PostgreSQL's built-in SHA-256 over canonical `jsonb` text; no crypto extension is required. See [PostgreSQL binary-string functions](https://www.postgresql.org/docs/16/functions-binarystring.html). Fingerprints detect incompatible measurement changes; they are not authentication credentials or proof of causality.

## Transaction and retention order

Capture locks the target, then eligible sources in stable ID order. Observation writers and pruning use those same source locks. The adapter reads a coherent snapshot of locked streams and creates immutable baseline rows and retention pins on the same connection. Source locks precede any work enqueueing: compose `withDeploymentTimeout(withDeploymentBaseline(...))`, not the reverse.

Baseline pins protect the source's observation window for 604,800 elapsed seconds (seven days). Their expiry cannot be extended or mutated. Retention considers active pins before selecting deletions and removes at most 100 expired pins for its locked source before taking work/accounting locks. The saved baseline itself remains available after the underlying replay pin expires. Subsequent watch integration must also pin the post-deploy window before enabling watch jobs.

Migration `0018_deployment_baselines.sql` adds tables, scoped foreign keys, indexes and forced row-level security. It does not backfill historical deployments. Apply migrations before running the new retention adapter. Stop older retention consumers before eventually activating baseline capture: an older binary does not understand these pins.

The restricted application role needs `SELECT, INSERT` on `escalator_deployment_baseline` and `SELECT, INSERT, DELETE` on `escalator_deployment_pin`. Grant these only within the application's schema. RLS permits pin deletion only after expiry, even if the role has broader mutation grants; it permits no baseline updates or deletes. The migration role remains separate from the non-BYPASSRLS application role.
