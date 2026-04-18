# ADR-011: Hono for HTTP Server

**Status**: Accepted

## Context

The agent worker needs an HTTP server for health checks (`/healthz`), the A2A protocol endpoints, and operator communication (`POST /task`, `GET /status`).

## Decision

Use Hono with `@hono/node-server` as the HTTP framework.

## Alternatives Considered

- **Fastify**: Mature, fast, good plugin ecosystem. Heavier than needed — Hono provides the same routing and middleware capabilities with a smaller footprint.
- **Express**: Industry standard but showing its age. No native TypeScript types, middleware model is callback-based, performance is lower than alternatives.
- **Raw Node.js http module**: Zero dependencies but requires building routing, body parsing, and error handling from scratch. Not worth the effort for standard HTTP endpoints.
- **tRPC**: Type-safe RPC. The A2A protocol already defines its own JSON-RPC format — adding tRPC's type layer on top would conflict rather than help.

## Consequences

- Hono is ~14KB. Minimal impact on bundle size and startup time.
- Web-standard Request/Response API — code is portable across runtimes (Node.js, Deno, Bun, Cloudflare Workers) if we ever need to switch.
- Built-in middleware for CORS, compression, and error handling.
- `@hono/node-server` adapter runs Hono on Node.js's native http module.
- Routing is clean and type-safe: `app.get("/healthz", (c) => c.json({ ok: true }))`.
