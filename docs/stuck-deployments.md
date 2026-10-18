# Stuck deployment paging

The shared timeout job uses the authenticated grant's saved responder mapping. It never interprets the machine payload's display actor as an identity and never substitutes the deployer for a primary schedule assignment.

A timeout creates a distinct immutable page policy. It records the deployment ID and original service policy ID/version, tries the mapped deployer immediately, and schedules service fallback at two minutes. The service policy's bounded fallback reminders and terminal operator notification follow. If the deployer is unmapped, disabled, lacks acknowledgement authority, or has no enabled contact, the first step uses service fallback immediately. Invalid or cross-workspace contact data aborts the transaction rather than being treated as missing coverage. Terminal operator notifications retain their configured recipients even when a recipient cannot acknowledge the page.

The two-minute fallback is a delivery decision for stuck deployments, not a change to the regular 0/2/7/12/17-minute incident ladder. It leaves time for the first provider attempt and acknowledgement while ensuring provider failures do not prevent escalation. After downtime, only the current overdue level is dispatched. Provider acceptance is not acknowledgement.

Disabling a target/service or revoking its grant blocks new ingress but does not cancel a deployment deadline already accepted. Ordinary incident creation still requires an enabled service.

The start decorator writes the deterministic timeout job in the same transaction as the accepted deployment. The handler locks the target, any existing timeout page, and then its live work lease. Deployment timeout state, incident, page deadlines and audit commit together. A stale lease cannot mutate state. A late finish remains recorded on the timed-out deployment and does not resolve or erase the page.

## Integration status

This part supplies shared routing, scheduling and handler code. Host adapters must compose deployment and paging stores on one guarded PostgreSQL transaction, decorate accepted starts, register the timeout handler and reserve its deadline lane before enabling the feature. Those host changes follow in the stack; a standalone helper or separate database transaction is not activation.

## Verification procedure

Run the feature unit suite and existing paging conformance suite. The latter now round-trips the generated timeout policy, checks workspace isolation, and rejects rewriting its saved responder mapping. With disposable PostgreSQL configured using the existing standalone/Dashboard test variables, run both host suites to exercise the same persistence contract. No database is started by the tests.

Live scheduling, provider delivery, restart races and PostgreSQL execution remain not runtime-verified until the documented environment checks run. The shared tests cover in-memory atomic rollback, claim expiry, retries and late completion; they do not substitute for database concurrency tests.
