# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ── base: Node plus what Prisma needs ────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── deps: every dependency (dev too), installed from the lockfile ────────────
# Only the package files are copied first, so this slow layer is cached until a dependency changes.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# ── web-build: the React app (this stage is the "frontend Dockerfile") ───────
FROM deps AS web-build
COPY apps/web ./apps/web
RUN npm run build -w apps/web

# ── api-build: generate the Prisma client, compile TypeScript ────────────────
FROM deps AS api-build
COPY apps/api ./apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w apps/api

# ── prod-deps: production dependencies only ──────────────────────────────────
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace=apps/api

# ── migrate: one-off job that applies database migrations ────────────────────
FROM api-build AS migrate
WORKDIR /app/apps/api
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ── api: the runtime image (LAST, so a plain "docker build ." produces this) ─
FROM base AS api
ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_WEB=true \
    WEB_DIST=/app/web-dist
COPY --from=prod-deps /app/node_modules ./node_modules
# The generated Prisma client (and its engine) live outside the package, so copy them across.
COPY --from=api-build /app/node_modules/.prisma ./node_modules/.prisma
COPY apps/api/package.json apps/api/
COPY --from=api-build /app/apps/api/dist apps/api/dist
COPY --from=web-build /app/apps/web/dist /app/web-dist
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
