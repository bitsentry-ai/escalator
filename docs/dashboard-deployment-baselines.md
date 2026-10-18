# Dashboard deployment baseline storage

The Dashboard adapter applies the shared accepted-start capture contract to the existing backend PostgreSQL database. The package workspace ID is the WorkOS organization ID; persisted rows contain `organization_id` and no competing workspace identifier.

This is partial T4.5 delivery. The adapter is not registered in the deployment runtime yet. Activation follows the durable watch state, jobs, bounded probe cadence changes and incident integration in both hosts. Existing deployments are not backfilled with newly reconstructed baselines.

## Transaction and retention

The deployment row, immutable evidence snapshot and baseline pins commit on one guarded Prisma transaction. Source locks precede capture and work/accounting locks. Compose timeout scheduling outside baseline capture so job enqueueing follows the capture. A capture error poisons the transaction even if a caller catches it.

The shared reader retains actual probe outcomes and metric counts, bounded configuration history, effective criteria and query-completeness flags. It stores measurement fingerprints without copying destination URLs, request bodies, queries or credential references. Missing or truncated history remains explicit; an empty inventory does not establish a healthy deployment.

Baseline pins cover the 15-minute pre-deployment window and expire after 604,800 elapsed seconds. Pruning honors active pins and removes at most 100 expired pins per locked source before taking work/accounting locks. Saved baseline rows cannot be updated or deleted by the application role; active pins cannot be shortened, updated or deleted.

## Upgrade and verification

Apply the additive deployment-baseline migration after existing deployment and signal/probe/metric migrations. Stop older retention consumers before activating baseline capture: they do not understand pins. The application role needs SELECT/INSERT on baseline rows and SELECT/INSERT/DELETE on pins, in addition to existing privileges. It must not own the tables or have BYPASSRLS. Post-watch pins and cadence restoration are separate activation prerequisites.

`pnpm --filter @bitsentry/backend exec prisma validate` validates the schema without starting infrastructure. The migration is generated from the preceding schema and supplemented with scoped checks, immutable-row policies and forced RLS.

For database verification, configure both `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` against one disposable database, with distinct migration and restricted application roles. The existing test helper creates and removes an isolated schema; never point these variables at production. Run:

```sh
pnpm run build:packages
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand deployment-baselines-postgres retention
```

The tests cover actual values, tenant isolation, immutable snapshots and pins, protection from pruning, and all-or-nothing rollback. No test database was available during implementation: PostgreSQL execution, concurrent lock behavior and full upgrade rehearsal remain not runtime-verified. D3 activation still depends on integrating the separate Dashboard secret-broker stack; this adapter does not substitute another credential store.
