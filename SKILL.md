# SKILL.md — Kea Dev Stack Quick Reference

> **Read this at the start of every session.** It covers the dev stack, ports, log paths, per-package commands, and what is and isn't possible without `docker compose` running.

For deep architecture, see [`AGENTS.md`](AGENTS.md). For per-package conventions, see each package's `.instructions.md`.

---

## Topology & ports

| Service | Port | Profile(s) | Purpose |
|---|---|---|---|
| postgres | `5432` | `infra`, `dev`, `all` | System of record for sessions/sitemap/findings/messages |
| api (`@kea/api`) | `4000` | `api`, `dev`, `all` | REST surface; agent + dashboard read/write here |
| dashboard (`@kea/dashboard`) | `4200` | `dashboard`, `dev`, `all` | Operator UI (Lit SPA) |
| agent (`@kea/agent`) | — | `agent`, `all` | Pi-driven coordinator + tester sub-agent; one-shot crawl, no HTTP surface |
| ollama | `11434` (host) | (host-native) | Local LLM backend; runs on the host, NOT in compose. Use `bash skill://ollama/scripts/start.sh` to launch. The legacy in-compose ollama lives under the opt-in `compose-llm` profile. |
| seq | `5341` ingest / `8080` UI | `infra`, `agent`, `all` | Structured log sink (pino → seq) |
| sites (blog/forms/shop) | `8081` / `8082` / `8083` | `sites`, `dev`, `all` | Fixture targets to crawl |

**Default URLs** when running `docker compose --profile dev up` (host-native ollama runs separately):

- API: `http://localhost:4000`
- Dashboard: `http://localhost:4200`
- Seq (logs): `http://localhost:8080`
- Postgres: `postgres://kea:kea@localhost:5432/kea`

## Common workflows

```bash
# Full local stack (infra + api + dashboard + sites + seq; agent and LLM run on the host)
docker compose --profile dev up -d

# Add the agent container (talks to host ollama via host.docker.internal)
docker compose --profile agent up -d

# Run the agent on the host instead (preferred for dev): see `agent/.env.example`
(cd agent && npm run dev)

# Legacy: in-compose ollama service (opt-in only)
docker compose --profile compose-llm up -d ollama

# Everything (also boots the sites in the `all` profile)
docker compose --profile all up -d

# Just the database
docker compose --profile infra up -d postgres

# Tear it all down
docker compose down            # keep volumes
docker compose down -v         # nuke volumes (postgres-data, ollama-models, seq-data, agent-data)
```

## Per-package commands

All TS packages share the same script vocabulary. Run from the package directory.

| Command | What it does |
|---|---|
| `npm run dev` | Start in watch mode (`tsx watch` for agent/api; `vite` for dashboard) |
| `npm run build` | Production build (esbuild for api, vite for agent/dashboard) |
| `npm run start` | Run the built artifact |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` (CI mode) |
| `npm run test:watch` | `vitest` (watch mode) |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check (CI gate) |

### `@kea/api` extras (Drizzle)

| Command | What it does |
|---|---|
| `npm run db:generate` | Generate a new SQL migration from schema diffs |
| `npm run db:migrate` | Apply migrations (run against a live postgres) |
| `npm run db:studio` | Drizzle Studio in the browser |

> **Migrations live only in `@kea/api`.** The agent's `db:*` scripts are stubs that just `echo`. Don't add migration logic to the agent.

### Engines

- **Node ≥ 24** for `@kea/agent` and `@kea/api`.
- **Node ≥ 22** for `@kea/dashboard`.
- Use `nvm use` (or equivalent) before running outside docker.

## What works without docker compose

| Capability | Needs docker? | Notes |
|---|---|---|
| `@kea/shared` build / typecheck / test | No | Pure TypeScript, no I/O. |
| `@kea/api` typecheck / test | No | Tests use in-memory routes via `app.request()`. |
| `@kea/api` `dev` against live DB | Yes (`postgres`) | Set `DATABASE_URL=postgres://kea:kea@localhost:5432/kea` after `docker compose --profile infra up postgres`. |
| `@kea/api` migrations | Yes (`postgres`) | `db:migrate` against the dev DB. |
| `@kea/dashboard` `dev` | Yes (`api`) | The SPA reads only from the API; no other backend. Point it at `http://localhost:4000`. |
| `@kea/agent` `dev` | Yes (`api` + LLM) | Needs `KEA_API_URL` reachable and `LLM_BASE_URL` reachable (Ollama or vLLM). |
| Operator (Go) tests | No | envtest runs an in-process Kubernetes API; no real cluster. |
| End-to-end crawl | Yes (full stack) | `--profile all` brings up sites/blog (etc.) as crawl targets. |

Feature/scenario API routes are covered by `@kea/api` integration specs when `TEST_DATABASE_URL` is set.

## Logs

- **Format**: structured JSON via `pino`. Each module gets a child logger via `createLogger("module-name")`.
- **Sink in dev**: every TS service ships logs to **Seq** (`http://localhost:8080`). When seq isn't running, logs fall back to stdout.
- **Levels**: `error` for failures, `warn` for degraded, `info` for lifecycle events, `debug` for detailed flow.

## Environment essentials

| Variable | Default (dev) | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://kea:kea@postgres:5432/kea` | api |
| `KEA_API_URL` | `http://api:4000` (in-cluster) / `http://localhost:4000` (host) | agent |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` (host) / `http://host.docker.internal:11434/v1` (in compose) | agent |
| `SEQ_URL` | `http://seq:5341` | api, agent |
| `PORT` | `4000` (api) | api |
| `TARGET_URL` | (per crawl) | agent |
| `SESSION_ID` | (auto if unset) | agent |
| `SESSION_CONFIG_JSON` | `{}` | agent (JSON-encoded session config; used to seed features at startup, FDD-0010). |

## Test fixtures

The `sites/` directory contains three fixture web apps to crawl in dev:

- `blog` (port `8081`) — static blog
- `forms` (port `8082`) — pages with forms / interactions
- `shop` (port `8083`) — Node-based mini-storefront

Bring them up with `--profile sites` or `--profile dev` / `--profile all`.

## Container constraints (when building images)

- Non-root user, read-only root filesystem, all Linux capabilities dropped (see ADR-012).
- Writable mount points: `/data` (legacy SQLite path, now obsolete) and `/tmp` (Playwright profiles, downloads).
- Don't write to the working directory at runtime — it isn't writable.

## Conventions to remember

- **Imports use `.js` ESM extensions** even though sources are `.ts`.
- **No barrel `index.ts` re-exports** — import from the source file directly.
- **Result types over throws** in business logic (see ADR-009). Throws are reserved for startup-time and unrecoverable boundaries.
- **Tests are colocated**: `foo.ts` next to `foo.spec.ts`.
- **Custom elements in the dashboard MUST start with `kea-`.**

## Where to look next

- Architecture & decisions: [`AGENTS.md`](AGENTS.md)
- Product intent (per feature): [`docs/fdd/`](docs/fdd/)
- Technical decisions (frozen): [`docs/adr/`](docs/adr/)
- Per-package conventions: each package's `.instructions.md`
