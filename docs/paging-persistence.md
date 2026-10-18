# Paging persistence contract

T2.3 is split across the contract/conformance part and the following host adapters.
This part does not activate page creation or delivery in either host.

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

PostgreSQL adapter registration, migrations and opt-in test commands follow in
the next parts. No test database is configured here; PostgreSQL lock/RLS/runtime
behavior is not verified by the memory fixture. Never run these checks against
an application database or start infrastructure implicitly.
