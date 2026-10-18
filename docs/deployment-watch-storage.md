# Deployment watch persistence

The shared watch transaction derives initial records from a recorded deployment finish. Initialization is idempotent under the deployment target lock. Reads and updates bind the workspace, target, service, environment and deployment; a caught operation error still aborts the physical transaction.

Updates use compare-and-swap revisions and the current transaction's database time. Every captured stream must be accounted for using its captured criteria and source ID. Missing baseline evidence cannot become a healthy verdict. A failed watch requires an existing incident in the same workspace, service and environment before the verdict can commit. Page creation and the watch update can share the same rollback unit. The first linked incident and finalized verdict are immutable.

The standalone adapter stores watches in `escalator_deployment_watch`, with forced row-level security and scoped foreign keys. Initial insertion locks the captured sources and pins their 30-minute watch window until seven elapsed days after the recorded finish. This uses the existing retention pin table and pruning protection. Pins and watch records commit together; repeated initialization does not extend retention. An absent historical baseline creates no source pins and remains insufficient evidence.

This adapter is not registered with the application runtime yet. Dashboard persistence, finish-triggered durable jobs, evidence collection, incident coalescing, cadence adjustment/restoration and read routes are subsequent layers. Do not treat the presence of this table as an active watch system.

## Verification procedure

The shared memory tests run with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

PostgreSQL checks are delivered but not runtime-verified without an explicitly disposable test database. Configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` following the existing database test procedure. Never use production credentials. Then run:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
```

The opt-in watch tests check concurrent idempotent initialization, durable reads from a fresh adapter, scoped access, poisoned rollback, stale revision rejection, source pins and unscoped RLS reads. They create only test-scoped objects through the existing fixture. Database lock/concurrency behavior, pin expiry and pruning under active watch traffic remain unverified in an environment without PostgreSQL. Full job integration must add lease-loss, restart, duplicate execution and page/incident coalescing scenarios before watch activation.
