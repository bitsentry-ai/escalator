# syntax=docker/dockerfile:1
# Build context is apps/escalator, copied out of the monorepo if desired.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS tools
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.32.1
WORKDIR /app

FROM tools AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/features/package.json ./packages/features/package.json

FROM manifests AS production-dependencies
RUN pnpm --filter @bitsentry-escalator/server... install --prod --frozen-lockfile

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/packages/features/node_modules ./packages/features/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/packages/features/package.json ./packages/features/package.json
COPY --from=build /app/packages/features/dist ./packages/features/dist
COPY --from=build /app/apps/web/dist ./apps/server/public
COPY --from=build /app/scripts/capacity-process.cjs /app/scripts/capacity-snapshot.mjs /app/scripts/capacity-evaluate.mjs ./scripts/
USER node
EXPOSE 3000
# Liveness only. Authenticated readiness and the external watchdog are separate.
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
 CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"3000")+"/health/live",{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})'
CMD ["node", "apps/server/dist/start.js"]
