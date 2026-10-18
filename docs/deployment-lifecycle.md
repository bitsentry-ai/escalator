# Deployment lifecycle

The shared contracts and pure lifecycle functions are the foundation for deploy
ingress. This part does not expose routes, persist deployments or activate pages
and watches. Both hosts will use these decisions through scoped transactions.

## Identity and input

Version 1 start input carries source, external deployment ID, environment ID,
actor, commit and/or artifact, and event time. Finish input repeats the source,
external ID and environment, with actor, event time and final outcome. The
authenticated grant must match the environment; the host resolves workspace and
service from the grant, never from JSON. Unknown fields are rejected.

Actor is provenance text, not a responder identity. The initial token ID and
optional mapped responder come from trusted authentication and are snapshotted.
Rotation or mapping changes do not rewrite an existing deployment. Deployments
must not inherit authority from actor names or artifact strings.

Times are UTC and normalized to milliseconds. Future events and finishes before
the reported start are rejected. Hooks must use synchronized clocks. The trusted
timeout policy is 60–86,400 seconds from reported start, so delayed start delivery
can already be overdue; receipt time does not restart the timeout.

## Transitions and replay

- A new start creates `STARTED`. Identical starts remain duplicates after completion.
- Changed immutable start data conflicts; it never resets a deployment.
- Finish without a recorded start returns `missing_start`; it does not fabricate one.
- The first accepted finish sets `SUCCEEDED`, `FAILED` or `CANCELLED`.
- A due timeout sets `TIMED_OUT` only while still `STARTED`.
- A finish received after a committed timeout records its outcome and timestamps,
  retaining `TIMED_OUT` and the original timeout time.
- Identical finish retries are duplicates; different terminal outcomes, actor or
  event time conflict. Rejected attempts must be retained by the application audit.

The application must serialize each deployment. In a finish/timeout race, the
first committed transition wins: a completed deployment suppresses a subsequent
timeout, while an already committed timeout remains visible after late finish.
The pure functions are deterministic for that persisted state and input; they do
not claim that different transaction orders produce identical state.

The persistence layer must atomically commit state, idempotency receipt, audit and
durable deadline/page intent. Authentication and expiry are checked before replay
responses too. A reducer result alone supplies none of these runtime guarantees.

## Separate health observation

`PENDING`, `PASS`, `WARN`, `FAIL` and `INSUFFICIENT_DATA` are watch verdicts, separate
from deployment lifecycle. A successful deploy does not imply a healthy service.
Watch orchestration, baseline retention and related incidents arrive in T4.5;
there is no rollback, promotion gate or release lock here.

## Verification

`pnpm --dir apps/escalator --filter @bitsentry-escalator/features test` includes
the lifecycle matrix, timeout/finish races, persisted replay, conflicting events,
scope checks, untrusted actor mapping, chronology and record invariants. These
are pure unit checks and require no PostgreSQL or running host.
