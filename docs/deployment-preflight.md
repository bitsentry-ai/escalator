# Deployment coverage preflight

`DeploymentPreflight` shares one implementation between hosts. Both hosts expose
machine preflight and authenticated coverage history/override procedures.
A preflight response alone cannot stop a pipeline that ignores it.

A deployment write grant selects the workspace, target and mapped deployer. The
request supplies deployment correlation and environment, never identity or
permission to override. Read grants cannot create decisions. Every attempt,
including replay, rechecks grant expiry/revocation and enabled target/service.

The decision records a bounded coverage snapshot and expires after two minutes.
It excludes the mapped deployer and requires another eligible configured
responder. Declared coverage is not evidence that a person is awake or that a
provider can deliver. Missing configuration or deployer mapping blocks ordinary
approval. Database errors propagate; callers must stop protected deployment
hooks on errors, timeouts or malformed responses.

## Retry and history semantics

A command key identifies the original canonical input and mapped deployer. A
replay preserves the immutable proof and does not renew its expiry or append
another audit event. Changed input conflicts. A new key requests a new decision.

The response's top-level decision is the current result; `proof` is historical.
Replays re-evaluate current hours and configuration. Expired proofs and changed
configuration block even if the original proof allowed the deployment. Consumers
must enforce the top-level result, not the historical evaluation nested in proof.

Authorized history reads return only the decision, not the stored command key or
request hash. They remain available with writes disabled for that workspace.

## Overrides

An administrator must supply a non-empty reason through a host-authenticated
actor, with authority checked against current persisted responder state. An
override creates a separate immutable, short-lived decision and audit event
linking the previous proof. It never edits or removes the original block.
Retries check the current override actor's authority too. Token JSON cannot
choose an override actor. A stale or expired override must be evaluated again.

Decision and audit insertion commit together. Failure to persist either rolls
back the operation. No silent or offline fail-open mode is provided.

## Verification

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/features test` for
in-memory authorization, retry, expiry, stale evidence and audit rollback cases.
Host-specific PostgreSQL procedures cover the persistence contract separately;
no disposable database is configured in the implementation environment.

## Host routes and start enforcement

Standalone exposes `POST /v1/deploys/preflight`; Dashboard exposes
`POST <API prefix>/v1/escalator/deploys/preflight`. Send the scoped deployment
write grant as a bearer token, JSON content type and an `Idempotency-Key` header.
The version-1 body contains `source`, `externalId` and `environmentId`.

A successful evaluation returns HTTP 200 even when its decision is `block`.
Protected hooks must check the top-level decision and stop on a block, missing
proof, timeout, malformed response or HTTP error. Preflight shares the existing
8 KiB request limit and eight in-flight slots with start/finish; there is no queue.

Pass the returned proof's ID as `coverageDecisionId` in the start body. For a new
start, the same authenticated database transaction verifies correlation,
environment, mapped deployer, target revision, evidence, expiry and live override
authority. A blocked proof returns HTTP 409 with `coverage_blocked`; unavailable
infrastructure returns HTTP 503. Neither response permits a protected deploy.

The accepted deployment and command receipt retain the applied proof ID. Finish
and timeout transitions preserve it. Replaying an already committed start returns
its original result after live grant authentication; it is a historical receipt,
not a new coverage approval. A new request cannot retrofit approval onto a prior
tracking-only start.

Requests without `coverageDecisionId` remain tracking-only for pipelines that do
not enforce preflight. They contain no approval claim. Protected hook recipes
must require a proof explicitly; Escalator cannot stop an external pipeline that
ignores its check.

Browser clients use standalone `deployments.coverage` / `overrideCoverage` or
Dashboard `deploymentCoverage` / `overrideDeploymentCoverage` tRPC procedures.
Actors come from host authentication, never request JSON. Dashboard mutations and
machine ingress retain the existing broker-availability gate: activation depends
on integrating the separate Dashboard secret broker stack.

Unit tests cover shared admission, controller framing, trusted actor mapping,
blocked starts, immutable proof links, replay and rollback. PostgreSQL execution
and live host startup have not been exercised in this environment. The deployment
screen and platform-specific hook recipes are delivered in later Phase 4 tasks.
