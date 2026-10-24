# Escalator

Escalator is BitSentry's self-hosted on-call service. It takes signals from monitoring sources, probes, heartbeats and deploy hooks, opens operational incidents, pages the right responder through escalation policies and channels, watches deployments, and runs model-backed investigations with cited evidence.

One deployment is one app image plus PostgreSQL. It needs no BitSentry monorepo checkout, Desktop CE, WorkOS, Encore or Redis.

## What we never compromise on

### 1. A page is never silently lost

People rely on Escalator to wake them up. Paging state is durable: incidents, page policies, escalation deadlines and the opening audit commit in one transaction, and database leases are the recovery authority. A missing schedule or contact produces an explicit uncovered step, never a quiet skip. When delivery is uncertain, expect a duplicate rather than risk a missed page.

### 2. Secrets stay secret

Credentials are encrypted with the mounted keyring and released only to a trusted adapter, bound to a live work claim. Durable work carries opaque secret IDs, never values. Webhook bodies and model output never decide which secret is read. No plaintext in errors, logs, tickets or command arguments.

### 3. Workspaces are isolated

Every read and write is scoped to the authenticated workspace. Another workspace's ID returns not-found. The runtime database role runs under row-level security and never owns tables. Browser-supplied tenant or permission fields grant nothing.

### 4. Honest results

A backtest, investigation or health check reports what it actually measured. A token-limited model answer is a partial outcome even if its JSON parses. No silent retries, no fallback to another model, no capacity claim without recorded measurements.

## How to work

Understand the real constraint before changing anything, then make the smallest change that makes the correct behavior unsurprising. Do not keep complexity just because it exists, and do not add machinery because it looks impressive. Measure twice, cut once, and YAGNI.

Treat this file as good defaults, not hard rules. The developer's instructions override anything here. If a rule fights the task in front of you, say so plainly and get sign-off before breaking it.

## A small glossary

- **you** means the agent reading this file.
- **we** and **maintainers** mean the people building Escalator, who you are talking to now.
- **operator** means the person who installs and runs an Escalator deployment.
- **responder** means a person who can be paged.
- **workspace** means one tenant. Standalone runs one workspace, set by `ESCALATOR_WORKSPACE_ID`.
- **host** means an application that mounts the shared features package. `apps/server` with `apps/web` is the standalone host.
- **signal** means an incoming event from a source, probe, heartbeat or deploy hook.
- **page** means the durable escalation run for an incident, with its frozen policy and deadlines.
- **channel** means a delivery route such as email or Pushover.
- **rule** means a detection rule. Rules are drafted, reviewed, backtested or replayed, then activated.
- **deploy watch** means the post-deploy check that a protected deployment hook starts.
- **investigation** means a bounded model run that produces a report with validated evidence.
- **keyring** means the mounted JSON key file named by `ESCALATOR_SECRET_KEY_FILE`.

## The ways to hurt yourself

1. **Using a real database.** Never run the server, `db:migrate`, `secrets:rotate` or `auth:operator` against a database that holds real records. Database tests need `ESCALATOR_TEST_MIGRATION_DATABASE_URL` and `ESCALATOR_TEST_DATABASE_URL` pointing at one disposable database, with separate migration and restricted application roles. Without those variables the database scenarios are skipped, which is fine for most changes.
2. **Touching secrets.** Never create, print, commit or overwrite a keyring, `app.env`, `secrets/`, `operator/` or a backup. They are gitignored for a reason. Never generate a fresh key to replace a lost one; that makes old ciphertext unrecoverable.
3. **Emptying queues.** Never delete paging rows, mark work delivered, or cancel pages to make a queue empty or a test pass. Stopping dispatch is not a safe rollback once paging is enabled.
4. **Starting servers.** Do not start the server, the web dev server or the compose stack unless the developer asks. Build, lint, typecheck and test are the verification tools.
5. **Editing it from the monorepo.** This repository is the `apps/escalator` submodule of the BitSentry monorepo, which excludes it from its workspace, lint and Docker context. Change Escalator here, then bump the pointer there when asked.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Hosts.** Features live in `packages/features` so more than one host can mount them. The Dashboard host is parked on the monorepo `escalator/dashboard-host` branch and is not on monorepo `main`. Keep the package host-neutral: hosts implement ports, the package owns the decisions.
- **Server and screen.** A capability usually needs the use case in `application/`, the tRPC adapter and repository in `apps/server`, and the screen in `packages/features/src/ui` mounted by `apps/web`.
- **Browser and server areas.** `ui`, `contracts` and `locales` are browser code and may not import server areas. `scripts/check-boundaries.mjs` enforces this and the package exports.
- **Locales.** Every user-visible string goes in every locale under `packages/features/src/locales`. `scripts/check-locales.mjs` checks them.
- **Schema.** Schema changes are a new numbered SQL file in `apps/server/migrations`. Grant the runtime role only what it needs and keep row-level security on new tables. Never edit an applied migration: the migrator checks each applied file's checksum and refuses to run when one changed.
- **Audit.** Administrative changes write their audit event in the same transaction as the change.
- **Agents and hooks.** A capability an operator triggers from a screen is usually also reachable by a machine grant or a deployment hook. That only works when it is a use case, not adapter code.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Activation needs deactivation, a page needs acknowledgement and resolution.
- **Docs.** Check whether the change makes a page in `docs/` inaccurate.

## Verifying

- `pnpm install --frozen-lockfile`, then `pnpm run build`, `pnpm run typecheck` and `pnpm run lint` must pass. Lint includes the boundary and locale checks.
- While you iterate, run one package's tests: `pnpm --filter @bitsentry-escalator/features test`, `pnpm --filter @bitsentry-escalator/server test` or `pnpm --filter @bitsentry-escalator/web test`. Script tests run with `node --test scripts/*.test.mjs`.
- CI runs `pnpm typecheck`, `pnpm -r test` with disposable PostgreSQL roles, the script tests and `pnpm i18n:audit:integrity` on every pull request.
- Behavior changes ship with focused tests for that behavior. Persistence, locking and isolation changes need a PostgreSQL scenario, not only an in-memory one.
- Logic, data, state and protocol bugs get a failing test first, then the fix. Purely visual bugs get before/after screenshots instead of a test.
- Test meaningful logic or observable behavior. Do not add tests that only assert callback wiring or mirror the implementation. Prefer an injected clock and the persisted outcome over real sleeps.

## Pull requests

- Never open a PR unless the developer asks.
- Branch from the latest `origin/main`.
- Titles are conventional commits in lowercase plain language, 72 characters or fewer, scoped to the area: `fix(paging): keep frozen recipients after a reclaim`.
- Follow `.github/pull_request_template.md`. Keep every heading, write "None." where a section does not apply, and say what you ran and what you did not.
- Keep each PR under 1,500 changed lines. Split bigger work into stacked PRs.
- UI changes need before/after screenshots. Upload them to the PR. Never commit PR-only assets.
- Do not add `Co-Authored-By` lines or AI attribution footers.

## Documentation

`docs/` holds one page per topic. Each page records the decisions and constraints a maintainer or operator would get wrong without it: ordering guarantees, isolation rules, failure behavior, operator procedures.

- Before adding a paragraph, ask what someone would get wrong without it. If the code answers the question, leave it out.
- When a decision changes, rewrite or remove the old text. Do not append another account of the new behavior.
- Operator procedures live in `docs/install/`, `docs/operations.md`, `docs/capacity.md` and `docs/hooks/`. Keep them accurate when configuration, migrations or defaults change.
- Do not commit progress notes, plans or agent scratch files.

## Where code lives

- `packages/features`: the shared feature package, built to CommonJS and ESM. `domain/` holds pure rules (escalation, schedules, detection rules, probes, deploys). `application/` holds use cases and the `ports/` hosts implement. `adapters/` holds intake, channel, probe and metric adapters. `investigation/` holds model resolution and investigation runs. `ui/` holds React screens, `contracts/` holds Zod schemas, `locales/` holds translations.
- `apps/server`: the standalone host. NestJS with tRPC, local authentication, and PostgreSQL repositories in `src/platform/database`. `src/platform` also holds auth, secrets, jobs, health and HTTP. `src/features` composes each feature from the package. SQL migrations live in `migrations/`.
- `apps/web`: the standalone browser app. Vite and React, mounting screens from `@bitsentry-escalator/features/ui`. The server serves its build.
- `deploy/`: database role and grant scripts used by `compose.yaml`.
- `scripts/`: package build, test runners, boundary and locale checks, capacity measurement.
- `Dockerfile` and `compose.yaml`: the production image and a reference single-host composition.

## Taste

- Decisions belong in the package, I/O belongs in the host. Domain code stays pure, adapters stay thin.
- Validate at the boundary with the Zod schemas in `contracts/`. Inferred types over annotations. `any` is the enemy.
- Fail with fixed, specific reasons. Never expose raw provider errors, prompt bodies, credentials or private endpoints in an error.
- Bound everything that comes from outside: input size, output tokens, deadlines, batch sizes, connections. Carry cancellation through every call.
- Make retries idempotent. The same request with the same content returns the original result; the same ID with different content fails.
- Comments say why: a constraint, an external quirk, or an invariant the code cannot show. Do not restate names, narrate steps, or record history.
