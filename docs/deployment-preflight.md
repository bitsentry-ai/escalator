# Deployment coverage preflight

`DeploymentPreflight` shares one implementation between hosts. This part adds the
use cases; machine routes, start enforcement and UI bindings follow separately.
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
