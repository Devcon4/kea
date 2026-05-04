# ── Build stage ───────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src/ src/

RUN npm run build

# ── Production stage ─────────────────────────────────────
FROM nginx:alpine

COPY --from=build /app/dist/ /usr/share/nginx/html/

# SPA fallback — serve index.html for all routes; proxy /api/ to the api service
RUN printf 'server {\n\
  listen 80;\n\
  resolver 127.0.0.11 valid=10s ipv6=off;\n\
  root /usr/share/nginx/html;\n\
  location /api/ {\n\
    set $upstream http://api:4000;\n\
    proxy_pass $upstream;\n\
    proxy_http_version 1.1;\n\
    proxy_set_header Host $host;\n\
    proxy_set_header X-Real-IP $remote_addr;\n\
  }\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ || exit 1
