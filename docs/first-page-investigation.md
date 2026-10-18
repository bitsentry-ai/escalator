# First-page investigation intent

An enabled model configuration now creates an `investigation.run` job in the same standalone PostgreSQL transaction as the operational incident, first page, escalation jobs and audit record. A duplicate page request retains the original intent. The intent ID is a stable hash of workspace and incident identity; changing a profile cannot restart an already paged incident.

The shared handoff reloads the persisted scoped page and incident. It requires an open page and unresolved incident, uses the transaction lifetime guard, and poisons the transaction on failure even if its caller catches the error. Host writes cannot escape that transaction. Dashboard uses the same optional handoff contract; its storage composition follows in the next stack part.

The standalone adapter locks the selected profile, then reads its profile and normalized source selections in a fresh statement snapshot. Evidence windows end at the incident opening time and extend backward by each saved, bounded lookback. It captures native probe, alert, metric and deployment versions with one scope-constrained metadata query. Missing source metadata is recorded as `missing`, so later execution must report unavailable evidence instead of discovering an ambient connection.

No secret is decrypted or redeemed during paging. A disabled model credential or unreachable local Ollama must fail investigation execution independently; neither triggers a network request inside the page transaction. Missing or disabled investigation settings create no investigation job. A storage failure rolls the entire first-page transaction back, preserving atomic retry behavior. This part does not activate a polling consumer or add report UI. Standalone readiness excludes `investigation.run` jobs from the general job age, so an unclaimed or long-running investigation cannot fail health or stop the watchdog heartbeat; investigation work is bounded by its own deadlines instead.

## Checks and remaining runtime proof

The shared memory tests cover timestamp and scope capture, detached snapshots, stable identity, duplicate first-page requests, committed job visibility, rollback after a caught enqueue error, and expired transaction handles. The standalone PostgreSQL tests cover atomic first-page/job persistence, duplicates, disabled/absent profiles and rollback.

No disposable PostgreSQL database is configured. Those database cases are delivered but not runtime-verified. To run them, provide `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` for an existing disposable database using the separate restricted roles described in `investigation-storage.md`, then run:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
pnpm --dir apps/escalator --filter @bitsentry-escalator/server test
```

Confirm that every `PostgreSQL first page` and `PostgreSQL rollback removes first page` case executes without a skip. Do not supply the application's database URL or start infrastructure as part of these checks. Before deployment, also exercise concurrent profile edits, credential revocation and source removal with the eventual runner: captured configuration must never be silently replaced, and investigation failures must leave paging deadlines available.
