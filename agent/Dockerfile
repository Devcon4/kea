# Build context: monorepo root (so @kea/shared at file:../shared resolves).

# ── Build stage ───────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /repo

# Install shared package first (its own deps are needed when vite/rollup
# bundles shared sources into the agent build).
COPY shared/package.json shared/package-lock.json shared/tsconfig.json shared/
COPY shared/src/ shared/src/
RUN cd shared && npm ci

COPY agent/package.json agent/package-lock.json agent/
RUN cd agent && npm ci

WORKDIR /repo/agent
COPY agent/tsconfig.json ./
COPY agent/vite.config.ts* ./
COPY agent/src/ src/

RUN npm run build

# ── Production stage ─────────────────────────────────────
FROM node:24-bookworm-slim

# Chromium for Stagehand (uses chrome-launcher, not Playwright)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Repo-shaped layout for the prod install: shared lives one directory up so
# `file:../shared` in the agent's package.json keeps resolving.
COPY shared/package.json shared/package-lock.json /repo/shared/
COPY shared/src/ /repo/shared/src/
RUN cd /repo/shared && npm ci --omit=dev

COPY agent/package.json agent/package-lock.json /repo/agent/
WORKDIR /repo/agent
RUN npm ci --omit=dev

COPY --from=build /repo/agent/dist/ dist/

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
