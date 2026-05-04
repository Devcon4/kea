/**
 * Session Routes — HTTP orchestration layer.
 *
 * Each handler follows the same DDD pattern:
 *   1. Validate input (zod schemas)
 *   2. Load the aggregate root from the repository
 *   3. Call a pure domain function to enforce business rules
 *   4. Persist the result through the repository
 *
 * No business logic lives here — it's all in domain.ts.
 */

import { Hono } from "hono";
import {
  CreateSessionSchema,
  UpdateSessionSchema,
  UpsertPageSchema,
  VisitPageSchema,
  DiscoverPageSchema,
  CreateFindingSchema,
  CreateChatMessageSchema,
} from "@kea/shared";
import type { EventBus } from "../events/bus.js";
import type { SessionRepository } from "./repository.js";
import {
  createSession,
  completeSession,
  failSession,
  addFinding,
  addMessage,
  visitPage,
  discoverPage,
  upsertPage,
} from "./domain.js";

export function createSessionRoutes(repo: SessionRepository, bus: EventBus): Hono {
  const app = new Hono();

  // ── Session lifecycle ────────────────────────────────

  app.get("/api/sessions", async (c) => {
    const rows = await repo.list();
    return c.json(rows);
  });

  app.get("/api/sessions/:id", async (c) => {
    const row = await repo.getById(c.req.param("id"));
    if (!row) return c.json({ error: "session not found" }, 404);
    return c.json(row);
  });

  app.post("/api/sessions", async (c) => {
    const body = CreateSessionSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Domain: factory validates and creates aggregate root
    const result = createSession(body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    const saved = await repo.save(result.value);
    bus.emit({ kind: "session-list", at: Date.now() });
    return c.json(saved, 201);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = UpdateSessionSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: transition state through domain functions
    if (body.data.status === "completed") {
      const result = completeSession(session, body.data.completedAt ?? undefined);
      if (!result.ok) return c.json({ error: result.error }, 422);
      const saved = await repo.save(result.value);
      bus.emit({ kind: "session", sessionId: saved.id, at: Date.now() });
      bus.emit({ kind: "session-list", at: Date.now() });
      return c.json(saved);
    }

    if (body.data.status === "failed") {
      const result = failSession(session, body.data.completedAt ?? undefined);
      if (!result.ok) return c.json({ error: result.error }, 422);
      const saved = await repo.save(result.value);
      bus.emit({ kind: "session", sessionId: saved.id, at: Date.now() });
      bus.emit({ kind: "session-list", at: Date.now() });
      return c.json(saved);
    }

    // No status change — just persist updated fields
    const updated = { ...session, ...body.data };
    const saved = await repo.save(updated);
    bus.emit({ kind: "session", sessionId: saved.id, at: Date.now() });
    bus.emit({ kind: "session-list", at: Date.now() });
    return c.json(saved);
  });

  app.get("/api/sessions/:id/stats", async (c) => {
    const stats = await repo.getStats(c.req.param("id"));
    return c.json(stats);
  });

  // ── Sitemap (owned entity, through aggregate) ────────

  app.get("/api/sessions/:id/sitemap", async (c) => {
    const sessionId = c.req.param("id");
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit")) || undefined;
    const entries = await repo.listPages(sessionId, { status, limit });
    return c.json(entries);
  });

  app.put("/api/sessions/:id/sitemap", async (c) => {
    const body = UpsertPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate root to enforce invariants
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: validate through aggregate
    const result = upsertPage(session, body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePage(session.id, result.value);
    emitSitemap(bus, session.id);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/sitemap/visit", async (c) => {
    const body = VisitPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = visitPage(session, body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePageVisit(session.id, result.value);
    emitSitemap(bus, session.id);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/sitemap/discover", async (c) => {
    const body = DiscoverPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = discoverPage(session, body.data.url);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePageDiscovery(session.id, result.value);
    emitSitemap(bus, session.id);
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:id/sitemap", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url query param required" }, 400);
    await repo.removePage(c.req.param("id"), url);
    emitSitemap(bus, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Findings (owned entity, through aggregate) ───────

  app.get("/api/sessions/:id/findings", async (c) => {
    const sessionId = c.req.param("id");
    const url = c.req.query("url");
    const scenarioIdRaw = c.req.query("scenarioId");
    let scenarioId: number | undefined;
    if (scenarioIdRaw !== undefined) {
      const parsed = Number(scenarioIdRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return c.json({ error: "invalid scenarioId" }, 400);
      }
      scenarioId = parsed;
    }
    const rows = await repo.listFindings(sessionId, { url, scenarioId });
    return c.json(rows);
  });

  app.post("/api/sessions/:id/findings", async (c) => {
    const body = CreateFindingSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate root to enforce invariants
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: validate through aggregate
    const result = addFinding(session, {
      url: body.data.url,
      agentId: body.data.agentId,
      action: body.data.action,
      result: body.data.result,
      severity: body.data.severity,
      timestamp: body.data.timestamp,
      scenarioId: body.data.scenarioId ?? null,
    });
    if (!result.ok) return c.json({ error: result.error }, 422);

    const row = await repo.saveFinding(result.value);
    bus.emit({ kind: "findings", sessionId: session.id, at: Date.now() });
    bus.emit({ kind: "session-list", at: Date.now() });
    return c.json(row, 201);
  });

  // ── Messages (agent chat log) ────────────────────────

  app.get("/api/sessions/:id/messages", async (c) => {
    const rows = await repo.listMessages(c.req.param("id"));
    return c.json(rows);
  });

  /**
   * Multiplexed per-session SSE. Replaces the prior `/messages/stream` poll.
   * Emits two named event types:
   *   `event: message`  — payload is the saved ChatMessage row.
   *   `event: refresh`  — payload is `{ kind, at }` where kind is the slice
   *                       of state that changed (sitemap | findings | features
   *                       | session). The client refetches that slice; we never
   *                       push the changed data itself for non-message kinds
   *                       to avoid ordering races and payload bloat.
   *
   * No timers. Connection-lifetime is bus subscription only; close the
   * EventSource on the client to detach. Browsers auto-reconnect on transient
   * network errors and the dashboard refetches the relevant data on (re)open.
   */
  app.get("/api/sessions/:id/stream", async (c) => {
    const sessionId = c.req.param("id");
    const session = await repo.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    return c.body(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const unsubscribe = bus.subscribe((event) => {
            if (event.kind === "session-list") return;
            if (event.sessionId !== sessionId) return;

            try {
              if (event.kind === "messages") {
                controller.enqueue(
                  encoder.encode(
                    `event: message\ndata: ${JSON.stringify(event.message)}\n\n`,
                  ),
                );
                return;
              }
              controller.enqueue(
                encoder.encode(
                  `event: refresh\ndata: ${JSON.stringify({ kind: event.kind, at: event.at })}\n\n`,
                ),
              );
            } catch {
              // Stream already closed; subscription teardown handled below.
            }
          });

          c.req.raw.signal.addEventListener("abort", () => {
            unsubscribe();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  /**
   * Session-list-level SSE. The dashboard's home view subscribes here and
   * refetches `/api/sessions` whenever any event arrives. Emits both
   * list-shaped events (`session-list`) and per-session refresh events that
   * may affect list-displayed counters (sitemap pages, findings).
   */
  app.get("/api/sessions/stream", async (c) => {
    return c.body(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const unsubscribe = bus.subscribe((event) => {
            if (event.kind === "messages") return;
            try {
              const payload =
                event.kind === "session-list"
                  ? { kind: event.kind, at: event.at }
                  : { kind: event.kind, sessionId: event.sessionId, at: event.at };
              controller.enqueue(
                encoder.encode(`event: refresh\ndata: ${JSON.stringify(payload)}\n\n`),
              );
            } catch {
              /* stream closed */
            }
          });

          c.req.raw.signal.addEventListener("abort", () => {
            unsubscribe();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = CreateChatMessageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = addMessage(session, {
      agentId: body.data.agentId,
      content: body.data.content,
      thinking: body.data.thinking,
      timestamp: body.data.timestamp,
    });
    if (!result.ok) return c.json({ error: result.error }, 422);

    const row = await repo.saveMessage(result.value);
    bus.emit({ kind: "messages", sessionId: session.id, at: Date.now(), message: row });
    return c.json(row, 201);
  });

  return app;
}

/**
 * Sitemap mutations affect both the per-session view (sitemap tab + counters)
 * and the list view (page totals). Two emits keep both subscribers in sync;
 * the dashboard debounces by kind so a burst of `discoverPage` calls during a
 * crawl coalesces into a single refetch per consumer.
 */
function emitSitemap(bus: EventBus, sessionId: string): void {
  const at = Date.now();
  bus.emit({ kind: "sitemap", sessionId, at });
  bus.emit({ kind: "session-list", at });
}
