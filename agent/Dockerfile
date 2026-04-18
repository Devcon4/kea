# ── Build stage ───────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY drizzle/ drizzle/

RUN npm run build

# ── Production stage ─────────────────────────────────────
FROM node:24-bookworm-slim

# Chromium for Stagehand (uses chrome-launcher, not Playwright)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY drizzle/ drizzle/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)throw r.status})"

CMD ["node", "dist/index.js"]
