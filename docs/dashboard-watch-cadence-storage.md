# Dashboard watch cadence persistence

The Dashboard adapter uses `organizationId` equal to the WorkOS organization ID. The shared package receives that value as `workspaceId`; no second tenant identifier is stored. The additive migration introduces current cadence ownership and immutable per-watch/probe receipts, with composite ownership foreign keys, JSON consistency checks and forced row security.

`PrismaWatchCadenceRepository` composes deployment, baseline, watch, paging, probe and signal ports on one guarded Prisma transaction. Probe/source changes, restoration jobs, receipts and audit commit together. Deployment-token methods remain separate from signal-ingress tokens. This adapter is not registered in the live runtime until the watch worker lanes and budget are composed in both hosts.

Updates require the expected ownership revision and generation. Receipts cannot be updated or deleted by the application role. Deleting an expired or superseded lease preserves its receipts so a retried application cannot overwrite an operator edit.

## Verification procedure

No disposable PostgreSQL database is configured here. The database cases are delivered but **not runtime-verified**; they do not start infrastructure or use the application `DATABASE_URL`.

Configure `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` for an existing disposable database with distinct migration and restricted application roles. Run `pnpm run build:packages`, then `pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand`. Confirm all three cadence cases run rather than skip: concurrent replay plus fresh-adapter reads, rollback/retry of an entire application, and organization isolation plus receipt immutability. Retain the output with the migration version.

Dashboard activation also depends on integrating the separate secret-broker stack. This storage adapter neither copies that broker nor merges its plan. Live cadence timing, provider execution and Docker/Encore image inclusion remain unverified in this environment.
