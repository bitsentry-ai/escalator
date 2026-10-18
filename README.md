# Escalator workspace

This first stack part installs and builds the canonical feature package.
Server and web shells are supplied by later Phase 0 parts.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
node --test scripts/*.test.mjs
```

Requires Node 22.12+ and pnpm 10.32.1. No root checkout or host runtime is needed.
