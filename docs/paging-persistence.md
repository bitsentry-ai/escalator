# Paging persistence contract

T2.3 is split across the contract/conformance part and the following host adapters.
Both standalone and Dashboard adapters are implemented. Persistence alone does
not activate page creation or delivery.

A paging transaction includes foundation entities, the audit log and the durable
outbox. Adapters must use one physical transaction and the existing transaction
guard; catching a repository error cannot commit earlier writes. Every foreign
reference and uniqueness key includes the host workspace (Dashboard organization).
Page updates require a row lock, a matching revision and immutable policy data.
The first acknowledgement owner is retained through resolution. Resolving a page
never erases its acknowledgement or delivery history.

Uniqueness is required for each page/logical step, page/step/recipient, and
delivery/attempt number. The step records the resolved recipients, including an
explicit empty uncovered/skipped outcome. Retry does not resolve the schedule
again. Delivery records contain opaque contact IDs, never credentials.

An acknowledgement grant stores only a SHA-256 digest of a random credential.
Generate the credential immediately before the provider request; persist its
digest with the attempt, and keep the raw credential out of outbox payloads,
logs, audit events and provider response storage. A retry may issue a new grant.
Each valid grant resolves to the same first owner; expiry uses database time.
The transport must hash the presented credential before repository lookup.

Each network attempt has its own identity and claim token. Acknowledgement may
cancel pending/outstanding work, but a started attempt can still record its first
result against that identity. It cannot overwrite another attempt or revise a
recorded result. An unknown response remains unknown, never inferred as failure
or success. Provider receipts are restricted opaque identifiers, not raw bodies.

`test/conformance/paging.ts` exports the same assertions for both PostgreSQL
adapters and the serializable memory fixture. It covers uniqueness, digest-only
grants, expiry, tenant scope, concurrent acknowledgement, snapshot immutability,
transaction lifetime, terminal transitions, late results, and atomic rollback of
foundation, paging and outbox writes. Run the memory suite with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

The standalone adapter uses `0004_paging.sql`, with scoped composite foreign
keys and natural uniqueness constraints. Indexed relational columns are checked
against their validated JSON DTO fields; DTO workspace IDs are reconstructed
from the trusted transaction scope. Every new table enables and forces RLS.
Page and attempt mutations lock their own records using `FOR UPDATE`.
The shared application assembler validates references and lifecycle transitions;
the host storage adapter handles SQL only.

To run the identical suite against an **existing disposable PostgreSQL database**:

1. Configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and
   `ESCALATOR_TEST_DATABASE_URL` with the two roles described in the workspace
   README. Do not use an application database or an application URL fallback.
2. Run `pnpm --dir apps/escalator run build` from the monorepo root (or `pnpm run
build` from the standalone workspace).
3. Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test`.
   Check that the nine `standalone PostgreSQL paging` scenarios execute rather
   than skip. Fixtures create random test schemas, apply all migrations twice
   to check journal stability, restrict the application role, and remove the
   schemas after the suite. Existing application schemas are not migration targets.
4. Review the concurrent acknowledgement, late-attempt result and rollback
   results before enabling any paging routes. Run the separate RLS scenario too.

## Dashboard adapter

The Dashboard adapter reuses the same application transaction assembler. It
stores the trusted WorkOS organization ID in `organization_id`, joins the
existing Prisma transaction, and sets `app.organization_id` locally. The new
additive Prisma migration supplies the equivalent composite keys, payload
checks and forced RLS. It does not change legacy incident ownership or activate
paging routes.
