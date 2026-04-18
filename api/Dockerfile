# ── Build stage ───────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Copy shared package (file: dependency, bundled into output)
COPY shared/package.json shared/
COPY shared/src/ shared/src/
COPY shared/tsconfig.json shared/

# Install shared deps (zod) so esbuild can resolve them during bundling
WORKDIR /app/shared
RUN npm install --omit=dev

# Install all deps (needed for esbuild to resolve)
WORKDIR /app
COPY api/package.json api/package-lock.json api/
WORKDIR /app/api
RUN npm ci

COPY api/src/ src/
RUN npm run build

# ── Production stage ─────────────────────────────────────
# All deps are bundled — only node runtime needed, no npm ci.
FROM node:24-bookworm-slim

WORKDIR /app

COPY --from=build /app/api/dist/index.js dist/
COPY api/drizzle/ drizzle/

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r=>{if(!r.ok)throw r.status})"

CMD ["node", "dist/index.js"]
