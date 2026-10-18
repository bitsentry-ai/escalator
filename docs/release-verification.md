# Two-host release verification

Source inventory dated 2026-10-08; runtime conformance is not verified.
Both host test trees register each shared suite below. This proves fixture
wiring exists, not that a PostgreSQL run passes. The full command ledger and
build results belong to the implementation PRs.

The secret-store row covers the shared port contract with host fixtures; it does
not prove canonical Dashboard broker integration. Standalone encrypted-secret
PostgreSQL drills are separately provided in
`apps/escalator/apps/server/test/secrets/postgres.test.ts`.

## Shared adapter suites

| Shared suite            | Standalone fixture                                                                | Dashboard fixture                                                                  | Runtime status       |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- |
| `configuration`         | `apps/escalator/apps/server/test/database/configuration-postgres.test.ts`         | `apps/backend/src/features/escalator/test/configuration-postgres.spec.cjs`         | Not runtime-verified |
| `coverage`              | `apps/escalator/apps/server/test/database/deployment-coverage-postgres.test.ts`   | `apps/backend/src/features/escalator/test/deployment-coverage-postgres.spec.cjs`   | Not runtime-verified |
| `deployments`           | `apps/escalator/apps/server/test/database/deployments-postgres.test.ts`           | `apps/backend/src/features/escalator/test/deployments-postgres.spec.cjs`           | Not runtime-verified |
| `detection`             | `apps/escalator/apps/server/test/database/detection-postgres.test.ts`             | `apps/backend/src/features/escalator/test/detection-postgres.spec.cjs`             | Not runtime-verified |
| `foundation`            | `apps/escalator/apps/server/test/database/postgres.test.ts`                       | `apps/backend/src/features/escalator/test/postgres.spec.cjs`                       | Not runtime-verified |
| `health`                | `apps/escalator/apps/server/test/database/health-postgres.test.ts`                | `apps/backend/src/features/escalator/test/health-postgres.spec.cjs`                | Not runtime-verified |
| `heartbeats`            | `apps/escalator/apps/server/test/database/heartbeats-postgres.test.ts`            | `apps/backend/src/features/escalator/test/heartbeats-postgres.spec.cjs`            | Not runtime-verified |
| `incidents`             | `apps/escalator/apps/server/test/database/configuration-postgres.test.ts`         | `apps/backend/src/features/escalator/test/configuration-postgres.spec.cjs`         | Not runtime-verified |
| `investigation-reports` | `apps/escalator/apps/server/test/database/investigations-postgres.test.ts`        | `apps/backend/src/features/escalator/test/investigations-postgres.spec.cjs`        | Not runtime-verified |
| `investigations`        | `apps/escalator/apps/server/test/database/investigations-postgres.test.ts`        | `apps/backend/src/features/escalator/test/investigations-postgres.spec.cjs`        | Not runtime-verified |
| `metrics`               | `apps/escalator/apps/server/test/database/metrics-postgres.test.ts`               | `apps/backend/src/features/escalator/test/metrics-postgres.spec.cjs`               | Not runtime-verified |
| `paging`                | `apps/escalator/apps/server/test/database/paging-postgres.test.ts`                | `apps/backend/src/features/escalator/test/paging-postgres.spec.cjs`                | Not runtime-verified |
| `paging-scenarios`      | `apps/escalator/apps/server/test/database/paging-postgres.test.ts`                | `apps/backend/src/features/escalator/test/paging-postgres.spec.cjs`                | Not runtime-verified |
| `probes`                | `apps/escalator/apps/server/test/database/probes-postgres.test.ts`                | `apps/backend/src/features/escalator/test/probes-postgres.spec.cjs`                | Not runtime-verified |
| `replay-coverage`       | `apps/escalator/apps/server/test/database/replay-recording-postgres.test.ts`      | `apps/backend/src/features/escalator/test/replay-recording-postgres.spec.cjs`      | Not runtime-verified |
| `replay-recording`      | `apps/escalator/apps/server/test/database/replay-recording-postgres.test.ts`      | `apps/backend/src/features/escalator/test/replay-recording-postgres.spec.cjs`      | Not runtime-verified |
| `retention-accounting`  | `apps/escalator/apps/server/test/database/retention-accounting-postgres.test.ts`  | `apps/backend/src/features/escalator/test/retention-accounting-postgres.spec.cjs`  | Not runtime-verified |
| `retention-maintenance` | `apps/escalator/apps/server/test/database/retention-maintenance-postgres.test.ts` | `apps/backend/src/features/escalator/test/retention-maintenance-postgres.spec.cjs` | Not runtime-verified |
| `retention-pruning`     | `apps/escalator/apps/server/test/database/retention-pruning-postgres.test.ts`     | `apps/backend/src/features/escalator/test/retention-pruning-postgres.spec.cjs`     | Not runtime-verified |
| `rule-catalog`          | `apps/escalator/apps/server/test/database/rule-catalog-postgres.test.ts`          | `apps/backend/src/features/escalator/test/rule-catalog-postgres.spec.cjs`          | Not runtime-verified |
| `rule-labels`           | `apps/escalator/apps/server/test/database/rule-labels-postgres.test.ts`           | `apps/backend/src/features/escalator/test/rule-labels-postgres.spec.cjs`           | Not runtime-verified |
| `secrets`               | `apps/escalator/apps/server/test/secrets/store.test.ts`                           | `apps/backend/src/features/escalator/test/secrets.spec.cjs`                        | Not runtime-verified |
| `signals`               | `apps/escalator/apps/server/test/database/signals-postgres.test.ts`               | `apps/backend/src/features/escalator/test/signals-postgres.spec.cjs`               | Not runtime-verified |
| `stuck`                 | `apps/escalator/apps/server/test/database/stuck-deployments-postgres.test.ts`     | `apps/backend/src/features/escalator/test/stuck-deployments-postgres.spec.cjs`     | Not runtime-verified |
| `watch-runtime`         | `apps/escalator/apps/server/test/database/watch-runtime-postgres.test.ts`         | `apps/backend/src/features/escalator/test/watch-runtime-postgres.spec.cjs`         | Not runtime-verified |
| `work`                  | `apps/escalator/apps/server/test/database/postgres-work.test.ts`                  | `apps/backend/src/features/escalator/test/prisma-work.spec.cjs`                    | Not runtime-verified |

## Operator conformance run

Use disposable databases and distinct migration/restricted application roles.
The standalone pair is `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and
`ESCALATOR_TEST_DATABASE_URL`. The Dashboard pair is
`ESCALATOR_DASHBOARD_TEST_MIGRATION_DATABASE_URL` and
`ESCALATOR_DASHBOARD_TEST_DATABASE_URL`. Do not substitute production credentials
or remove the fixture role checks. Record server version, package commit, schema
revision and role characteristics without recording credentials.

After runtime authorization, build compiled exports, generate the Dashboard
Prisma client and execute both host suites using the [database-health procedure](database-health.md). Preserve test counts including skips; a zero-failure run with skipped
PostgreSQL cases is not conformance evidence. Fail release verification if either
adapter is missing a scenario, if equivalent inputs have divergent durable
outcomes, or if tenant isolation, lease ownership or atomic acknowledgement fails.

## Manual parity checklist

- Services and environments: current membership/role authorization, immutable
  workspace mapping, no ambiguous legacy ownership linkage.
- On-call: timezone/DST schedules, primary/peer/fallback escalation, no eligible
  responder behavior, provider attempts and acknowledgement cancellation.
- Detection: signed intake, dedupe and recovery, SSRF-safe probes, heartbeats,
  Prometheus/Grafana metrics, unavailable-data behavior, channel setup.
- Deployments: scoped machine credentials, coverage denial, stuck deployer page,
  post-deploy watch, missed or failed hook delivery.
- Investigation: first-page concurrency, read-only bounded evidence/model access,
  worker lease fencing, standalone Ollama, cancellation and report rendering.
- Rules: incident labels, retained replay, gaps and unknown precision, candidate
  generation without held-out leakage, explicit review and activation, rollback,
  export/import mapping and both host screens.
- Operations: process liveness versus authenticated readiness, stalled dispatcher,
  independent watchdog, encrypted-key restore and pending-page handoff.

Dashboard broker-dependent providers cannot be marked active before the separate
secret-store integration is present. Image startup, browser interactions, provider
requests, capacity measurement and restore drills remain separate runtime gates.
