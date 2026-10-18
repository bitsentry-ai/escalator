# Configuration database adapters

Both adapters compose configuration and paging with the foundation transaction.
All reads and writes use the host's tenant column. Scoped foreign keys protect
service, responder, schedule and preview references. Forced row-level security
hides data without an explicit transaction scope. Versioned replacements lock the
record and check its previous version again in the update statement.

Standalone migration `0005_configuration.sql` adds five tables. Its secret check
reads only the existence of an enabled provider secret; authentication secrets are
excluded. Contacts retain an opaque ID with a scoped foreign key.

Dashboard migration `20260920000000_escalator_configuration` adds the equivalent
models with `organizationId`, mapped to the WorkOS organization ID. It was generated
with Prisma's schema-to-schema diff and supplemented with JSON checks, deterministic
text collation and forced RLS. No existing migration is edited.

Dashboard secret metadata is an injected transaction-bound authorization callback.
The default returns false. The separate `secret-store/12-ops` schema still owns
credentials by user ID, so integration must supply an explicit authorized mapping
from the trusted organization to a credential and active generation. Do not infer
ownership from a caller-provided ID. This PR does not copy the broker schema or
resolve secret plaintext while holding configuration locks. Broker activation
remains dependent on that stack's integration, as agreed in D3.

Run the shared memory suite and adapter unit suites without infrastructure:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand
```

For PostgreSQL conformance, an operator must first supply a disposable database
with distinct migration and restricted, non-BYPASSRLS application roles. Standalone
uses `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL`.
Dashboard uses `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and
`ESCALATOR_DASHBOARD_TEST_DATABASE_URL`. The suites create isolated random schemas,
apply the relevant migrations, grant scoped test access and clean up afterwards.
Never point them at production or substitute the application's `DATABASE_URL`.
See the existing foundation database test procedures for role requirements.

Without these variables, database tests explicitly skip. Mocked SQL tests verify
bound values, version predicates and secret metadata filtering; they do not prove
live PostgreSQL behavior. No test database was available during implementation.
Production scheduler and API registration follow in the next stack part.
