# Escalator workspace

Independent Phase 0 host shells and the canonical shared feature package.
Copy this directory alone, then run:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
```

Requires Node 22.12+ and pnpm 10.32.1. No root checkout, Desktop CE,
WorkOS, Encore, database, or server process is required for these checks.
The server exports an app factory; operational behavior starts in Phase 1.
The package exports compiled CommonJS and ESM only. React is a peer dependency.
