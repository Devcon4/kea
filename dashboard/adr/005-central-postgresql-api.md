# ADR-005: Central PostgreSQL API replacing SQLite

**Status:** Accepted  
**Date:** 2026-04-12

## Context

The agent uses an embedded SQLite database for sitemap and findings storage. This works for a single agent instance but breaks when:

- Multiple agent instances run in parallel (one per CRD target)
- Agent pods are ephemeral — data dies with the pod
- The dashboard needs to aggregate data across all agents
- No shared data plane exists between agents and the UI

## Decision

1. Create **`@kea/api`** — a Hono + drizzle-orm service backed by **PostgreSQL**.
2. Create **`@kea/shared`** — shared types, result utilities, and zod validation schemas.
3. **Replace SQLite** in the agent with an HTTP client (`ApiClient`) that talks to `@kea/api`.
4. The dashboard fetches session/sitemap/findings data from the same API.

## Schema Design

The PostgreSQL schema adds a **sessions** table as the top-level entity:

- `sessions` — one row per agent run (id, targetUrl, status, config, timestamps)
- `sitemap` — composite PK `(session_id, url)` with cascade delete
- `findings` — FK to `session_id` with cascade delete

This scopes all data per session, enabling multi-agent aggregation.

## Data Flow

```
Agent → POST /api/sessions/:id/sitemap/visit → PostgreSQL
Agent → POST /api/sessions/:id/findings     → PostgreSQL
Dashboard → GET /api/sessions               → PostgreSQL
Dashboard → GET /api/sessions/:id/stats     → PostgreSQL
```

## Alternatives Considered

- **Shared SQLite on PVC** — SQLite doesn't support concurrent writers. Corruption risk.
- **Agent-exposed API** — Agents are ephemeral. Data dies with them.
- **Event streaming (NATS/Kafka)** — Overkill for this scale.

## Trade-offs

- **Network latency on hot path** — Agent's "have I visited this URL?" check now requires an HTTP round-trip. Acceptable for the ~100ms/page exploration loop. If profiling shows this is too slow, add a local in-memory cache in the agent.
- **New infrastructure** — PostgreSQL container. Adds operational complexity but is standard.
- **Schema coupling** — `@kea/shared` ensures agent, API, and dashboard all agree on types. Breaking changes are caught at compile time.

## Consequences

- Agent no longer needs `better-sqlite3`, `drizzle-orm/better-sqlite3`, or `drizzle-kit` as dependencies.
- Agent `.env` gains `KEA_API_URL` instead of `DB_PATH`.
- docker-compose adds `postgres` and `api` services.
- Dashboard `SessionService` fetches from `/api/sessions` instead of holding mock data.
