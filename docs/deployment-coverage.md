# Deployment coverage decisions

The shared preflight foundation evaluates declared availability for another
responder. It does not claim anyone is awake or guarantee channel delivery.
Eligible candidates are the current primary and peer schedule assignments plus
service fallback responders. The mapped deployer is excluded. A candidate needs
an enabled responder with acknowledgement capability, declared working hours at
the check time, and an enabled paging contact. Missing mapping, unavailable
routing, incomplete evidence or no eligible candidate produces a block.

Decisions last two minutes. Their binding includes workspace, target revision,
service, environment, policy, deployment source/external ID and mapped deployer.
An evidence fingerprint covers the policy, schedule versions, responder state,
availability and contact configuration. Lists are ordered before hashing. Raw
contact configuration and secret references are not returned in the evaluation.

A start must compare its current binding and evidence with the stored decision,
including before expiry: a working window or shift can end while the decision is
still fresh. Changed configuration makes a decision stale; a different deployment
cannot reuse it. Expiry is a half-open boundary. A role-authorized override needs
a nonempty reason and expires with its decision. The persistence boundary checks
that the override actor is still enabled and has the required capability.

## Persistence contract

The coverage repository extends the original deployment transaction. Both host
adapters must provide one coherent bounded evidence snapshot on that same
physical transaction, set `complete: false` on query overflow, and enforce
append-only decisions with unique target/key and target/decision ID constraints.
Coverage command keys occupy a separate namespace from lifecycle receipt keys.
No network I/O belongs inside this transaction.

The shared validation layer captures one snapshot per target and mapped deployer per transaction,
returns defensive copies, validates scope and target revision, rejects invented
evaluations and timestamps outside the live transaction, and poisons the whole
transaction after any operation failure. The caller must append the decision's
audit event in that transaction. The host must assert the guard before commit and
close it after the callback, including on errors.

This part supplies contracts, pure evaluation, decision helpers, persistence
ports and their shared guard. It does not yet persist decisions in either host,
activate a preflight endpoint, issue audited overrides or enforce decisions at
start. Those follow with both adapters and application/route bindings. No CI
protection is claimed until those pieces and the hook recipes are installed.

## Verification

Feature tests cover DST, half-open working windows, unknown mapping, role/contact
eligibility, stable fingerprints, changed versions, expiry, deployment binding,
override authorization, scope rejection, forged evidence, defensive copies and
poisoned/closed transaction handles. These tests need no database or listener.
PostgreSQL conformance and transactional audit rollback must additionally be
verified by the host adapters; there is currently no disposable test database.
