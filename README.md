# Escalator workspace

This stack part builds the canonical feature package and the NestJS/tRPC server
shell. The web shell is supplied by the next Phase 0 part.
The server exports an app factory; operational behavior starts in Phase 1.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
node --test scripts/*.test.mjs
```

Requires Node 22.12+ and pnpm 10.32.1. No root checkout or host runtime is needed.
