# Dashboard deployment watch storage

The Dashboard watch adapter uses the same `withDeploymentWatches` transaction contract as the standalone server. The package workspace ID is the trusted WorkOS organization ID; database rows carry only `organization_id`. Watch identity, source/criteria bindings, transaction-time validation, revision checks, incident matching and finalization all remain in the shared package.

The additive migration creates watch records with organization-scoped foreign keys and forced row-level security. A failed verdict requires a matching incident in the same organization, service and environment. Captured-source retention pins are inserted with the initial watch on the same physical transaction. Initialization retries retain the first watch and pin expiry.

Neither this adapter nor the preceding standalone adapter is activated by these persistence layers. Finish-triggered durable jobs, evidence evaluation, incident coalescing, probe cadence adjustment/restoration and watch read routes follow. Dashboard activation also retains the existing separate secret-broker integration requirement; this change does not substitute another credential store.

## Database verification

The delivered PostgreSQL tests are not runtime-verified in the implementation environment because no disposable test database is configured. In an equipped test environment, configure the existing `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` variables, then run:

```sh
pnpm run build:packages
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

The watch cases exercise concurrent initialization, durable adapter reads, organization isolation, stale revisions, poisoned rollback, captured-source pins and unscoped RLS reads. Run the standalone counterparts as described in `deployment-watch-storage.md` before asserting database parity. No database or live provider execution was performed when these tests were delivered.
