# Stuck deployment paging

The shared timeout job uses the authenticated grant's saved responder mapping. It never interprets the machine payload's display actor as an identity and never substitutes the deployer for a primary schedule assignment.

A timeout creates a distinct immutable page policy. It records the deployment ID and original service policy ID/version, tries the mapped deployer immediately, and schedules service fallback at two minutes. The service policy's bounded fallback reminders and terminal operator notification follow. If the deployer is unmapped, disabled, lacks acknowledgement authority, or has no enabled contact, the first step uses service fallback immediately. Invalid or cross-workspace contact data aborts the transaction rather than being treated as missing coverage. Terminal operator notifications retain their configured recipients even when a recipient cannot acknowledge the page.

The two-minute fallback is a delivery decision for stuck deployments, not a change to the regular 0/2/7/12/17-minute incident ladder. It leaves time for the first provider attempt and acknowledgement while ensuring provider failures do not prevent escalation. After downtime, only the current overdue level is dispatched. Provider acceptance is not acknowledgement.

Disabling a target/service or revoking its grant blocks new ingress but does not cancel a deployment deadline already accepted. Ordinary incident creation still requires an enabled service.

The start decorator writes the deterministic timeout job in the same transaction as the accepted deployment. The handler locks the target, any existing timeout page, and then its live work lease. Deployment timeout state, incident, page deadlines and audit commit together. A stale lease cannot mutate state. A late finish remains recorded on the timed-out deployment and does not resolve or erase the page.

## Integration

Both hosts compose deployment, coverage and paging stores on one guarded PostgreSQL transaction. The timeout decorator uses that same guard: even a validation or enqueue error caught by a caller makes the entire transaction uncommittable. The deployment ingress provider decorates accepted inserts to persist their timeout job before committing the command receipt. Each host's existing in-process scheduler registers `deployment.timeout` in its own deadline lane; paging dispatch and provider delivery remain in their existing lanes. No Redis or Encore job is introduced. This reserves one additional job worker per activated workspace; the existing 64-worker aggregate scheduler ceiling still applies, so configurations at the previous maximum must leave room for the timeout lane.

The standalone adapter uses its existing pool and workspace identity. The Dashboard adapter uses `organizationId`, clears the machine-token lookup scope inside the domain transaction, and keeps timeout activation behind the existing broker binding and organization rollout. Integrating the separate secret-broker stack remains required for Dashboard activation. Disabling a target or revoking its grant after acceptance does not cancel the committed deadline.

## Activating after a tracking-only intermediate build

The deadline decorator applies to newly accepted starts. It does not backfill deployments accepted by an earlier tracking-only part of this stack. Before upgrading such an installation, pause new deploy submissions, let in-flight deployments finish through their existing hooks, and verify that no `STARTED` deployments remain before switching to the timeout-enabled build. Resume submissions afterward. Do not mark an active deployment complete merely to satisfy this check. A live upgrade with unfinished legacy rows needs a separately tested scoped deadline backfill; this part does not provide or claim that backfill.

## Verification procedure

Run the feature unit suite and existing paging conformance suite. The latter now round-trips the generated timeout policy, checks workspace isolation, and rejects rewriting its saved responder mapping. With disposable PostgreSQL configured using the existing standalone/Dashboard test variables, run both host suites to exercise the same persistence contract. No database is started by the tests.

Live scheduling, provider delivery, restart races and PostgreSQL execution remain not runtime-verified until the documented environment checks run. The shared tests cover in-memory atomic rollback, claim expiry, retries and late completion; they do not substitute for database concurrency tests.

## PostgreSQL conformance

Provide two distinct URLs for an existing disposable database: a migration/role-provisioning connection and a restricted application connection. Tests refuse unconfigured execution and clean up their isolated fixtures. Do not point them at production.

| Host       | Environment variables                                                                      | Command                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Standalone | `ESCALATOR_TEST_MIGRATION_DATABASE_URL`, `ESCALATOR_TEST_DATABASE_URL`                     | `pnpm --dir apps/escalator --filter @bitsentry-escalator/server test`                                         |
| Dashboard  | `ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL`, `ESCALATOR_DASHBOARD_TEST_DATABASE_URL` | `pnpm --filter @bitsentry/backend exec jest --config src/features/escalator/test/jest.config.cjs --runInBand` |

Build shared packages before the Dashboard suite. The shared timeout suite checks rollback after caught validation errors, accepted-start/job rollback, timeout/page/audit rollback, duplicate claims, invalid claim tokens, concurrent finish-versus-timeout outcomes, scope isolation and late completion. It seeds an already-due deployment instead of starting a scheduler or sleeping for its timeout. The in-memory variant runs without a database; PostgreSQL variants remain not runtime-verified in this implementation environment.
