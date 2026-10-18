# Deployment coverage persistence

The standalone adapter saves immutable preflight decisions on the existing deployment transaction. Target locking, command receipts, durable work and audit retain one physical PostgreSQL transaction and the same poisoned-handle guard. The adapter is not activated by a route in this part.

## Evidence snapshot

One bounded SQL statement reads the target policy, its primary and peer schedules, relevant responders, declared working hours and configured contacts. Schedule resolution and eligibility stay in the shared domain evaluator. SQL selects evidence only.

Relevant responders are all members and overrides of those schedules, the policy fallback pool and the explicitly mapped deployer, including a deployer outside the rotations. Evidence is limited to 103 distinct candidate IDs and 2,060 contacts. Overflow sets `complete=false` and evaluation blocks; it never silently counts a truncated roster as available. These are evidence-query limits, not measured capacity claims.

Missing availability or enabled contacts means no declared coverage for that responder. A configured contact does not prove that a secret resolves, the provider delivers, or the responder is awake. Decisions expose IDs and a fingerprint, not private contact records.

The statement observes one READ COMMITTED snapshot. The transaction caches that snapshot by target and mapped deployer. A later start must obtain fresh evidence and revalidate expiry, configuration and override authority; storing a preflight is not permission to skip those checks.

## Stored identity

A scoped primary key protects decision IDs; a separate scoped target/command-key uniqueness constraint protects preflight retries. The stored JSON omits the trusted workspace identity and agrees with relational target, service, environment, policy, responder and timestamp columns. Only SELECT and INSERT RLS policies exist. Runtime roles must not own tables or bypass RLS.

The shared guard rejects foreign bindings, forged fingerprints, stale target revisions and unauthorized override actors. Caught operation errors poison the transaction so a caller cannot commit earlier writes after a rejected proof. The memory adapter is a test fixture, never a production fallback.

## Verification procedure

The shared conformance suite covers scoped reads, conflicting IDs/keys with a concurrent winner, audit rollback, caught failures, defensive copies, stale target revisions, current override capability and closed handles. The standalone PostgreSQL suite additionally checks forced scope and append-only policies under accidental UPDATE/DELETE grants.

No disposable PostgreSQL database is configured in the implementation environment. The PostgreSQL cases are delivered but skipped, not reported as passing.

In an authorized test environment, configure `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` for the same disposable database with distinct migration and restricted application roles. Never use the application `DATABASE_URL` or a production database. The existing fixture creates a random schema, applies migrations twice, exercises constraints/RLS and drops only that schema.

Run:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
```

Both tests must complete without skipped PostgreSQL cases before claiming runtime conformance. Do not start infrastructure from the coding agent environment. Dashboard coverage storage and preflight/start/override activation are delivered in subsequent stack layers.
